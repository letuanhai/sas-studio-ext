/**
 * SAS Studio editor toggle: swap the built-in editor for Ace, and back again.
 *
 * Injected into the page's MAIN world by sw.js on every toolbar click. Idempotent —
 * a second injection is a no-op because of the `window.__ssExt` guard below; the sw
 * then calls `window.__ssExt.toggle(libPath)` to actually flip state.
 *
 * Docs (read before touching AceEditorAdapter):
 * - SAS_EDITOR_API.md   - SAS.Editor API reference
 * - sas-editor.d.ts     - TypeScript definitions for that API
 * - EDITOR_USAGE_MAP.md - which SAS Studio files call which editor methods
 */
(function () {
  "use strict";

  if (window.__ssExt) return;

  // ==========================================================================
  // AceEditorAdapter - implements the SAS.Editor API on top of Ace
  //
  // Known-stubbed methods (audited against EDITOR_USAGE_MAP.md - only DMSEditor
  // consumes these, and none of it depends on a real return value except getHTML):
  //   cut/copy/paste()     - browser handles native clipboard, no-op
  //   canPaste()            - always true, no consumer branches on false
  //   setNextFocusHandler/setPreviousFocusHandler/setLibService/promptText/
  //   enableHint/regShortcuts - DMSEditor calls these defensively (`if (fn) ...`)
  //     but never reads a return value
  //   getContextMenu()      - returns null; the only caller (createCodeEditor's
  //     Ace path below) already try/catches around it
  //   getHTML()             - used by onPrintCode()/getSummary() for a printable
  //     export; Ace has no built-in HTML export without ext-static_highlight, so
  //     this returns escaped plain text instead of syntax-highlighted markup.
  //     ponytail: plaintext fallback, upgrade to ext-static_highlight if anyone
  //     actually complains about print output.
  // ==========================================================================
  // Pick an ace mode from a file name via ace/ext/modelist (loaded by ext-prompt,
  // with the SAS entry added in ace-patches.js). Unknown/no extension -> sas.
  // ponytail: modelist can't distinguish ".txt" from "no match" (both -> text
  // mode), so genuine .txt gets SAS highlighting too. Fine for SAS Studio.
  function aceModeFor(name) {
    try {
      const m = ace.require("ace/ext/modelist").getModeForPath(name).mode;
      if (m && m !== "ace/mode/text") return m;
    } catch (e) {}
    return "ace/mode/sas";
  }

  class AceEditorAdapter {
    constructor(containerId, content, modeId) {
      this.containerId = containerId;
      this.container = document.getElementById(containerId);
      this._isAceEditorAdapter = true;

      if (!this.container) {
        throw new Error(`[SS Ext] Container ${containerId} not found`);
      }

      this.container.innerHTML = "";
      this.container.style.width = "100%";
      this.container.style.height = "100%";

      const cfg = getAceConfig();
      this._darkTheme = cfg.darkTheme;
      this._lightTheme = cfg.lightTheme;
      const isDarkMode =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      const editorTheme = isDarkMode ? this._darkTheme : this._lightTheme;

      const resolvedMode =
        typeof modeId === "string" && modeId.startsWith("ace/mode/") ? modeId : "ace/mode/sas";
      this.aceEditor = ace.edit(
        containerId,
        Object.assign(
          {
            mode: resolvedMode,
            theme: editorTheme,
            showLineNumbers: true,
            showGutter: true,
            displayIndentGuides: true,
            behavioursEnabled: true,
            autoScrollEditorIntoView: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            enableSnippets: true,
            tooltipFollowsMouse: true,
            highlightActiveLine: true,
            highlightIndentGuides: true,
            highlightSelectedWord: true,
          },
          cfg.options,
        ),
      );

      // Watch for OS dark-mode changes; handler + mql kept for dispose() cleanup.
      // Reads this._darkTheme/this._lightTheme live (not the cfg captured above)
      // so an options-page theme-pair change still takes effect on the next flip.
      this._darkModeMql = window.matchMedia("(prefers-color-scheme: dark)");
      this._darkModeHandler = (event) => {
        this.aceEditor.setTheme(event.matches ? this._darkTheme : this._lightTheme);
      };
      this._darkModeMql.addEventListener("change", this._darkModeHandler);

      this.aceEditor.commands.addCommand({
        name: "openCommandPalette",
        description: "Open command palette",
        bindKey: { win: "Alt-Shift-P", mac: "Command-Shift-P" },
        exec: () => {
          try {
            openCommandPalette(this.aceEditor);
          } catch (e) {
            console.error("[SS Ext] Could not open command palette:", e);
          }
        },
        readOnly: true,
      });
      // Let SAS Studio handle F3/F4 instead of Ace's find-next/find-prev.
      this.aceEditor.commands.bindKey("F3", null);
      this.aceEditor.commands.bindKey("F4", null);

      if (content) {
        this.aceEditor.setValue(content, -1); // -1 -> cursor to start
      }

      this.eventHandlers = { textChanged: [], selectionChanged: [], caretMoved: [] };
      this.setupAceEventBindings();

      // Ace status bar (ace/ext/statusbar, format from the author's ace fork -
      // see src/ace-patches.js) as a non-intrusive overlay pinned to the editor's
      // bottom-right; pointer-events:none so it never blocks clicks. ext-statusbar
      // is loaded by loadNewAce(); guard in case it isn't.
      try {
        const StatusBar = ace.require("ace/ext/statusbar").StatusBar;
        this._statusEl = document.createElement("div");
        this._statusEl.className = "ssf-ace-statusbar";
        this._statusEl.style.cssText =
          "position:absolute;right:6px;bottom:2px;z-index:9;opacity:0.65;pointer-events:none;white-space:nowrap;";
        this._statusEl.style.fontSize = cssFontSize(cfg.options && cfg.options.fontSize);
        this.container.appendChild(this._statusEl);
        new StatusBar(this.aceEditor, this._statusEl);
      } catch (e) {
        console.error("[SS Ext] status bar unavailable:", e);
      }

      setTimeout(() => this.aceEditor.resize(), 10);

      // Property DMSEditor sets directly (DMSEditor.js:4188).
      this.log = null;

      // Internal controller object accessed directly by DMSEditor/DMSTask.
      this.ctrl_ = {
        insertText: (text) => this.aceEditor.insert(text),
        selection: (startLine, startCol, endLine, endCol) => {
          if (endLine === undefined && endCol === undefined) {
            this.aceEditor.moveCursorTo(startLine, startCol);
          } else {
            const Range = ace.require("ace/range").Range;
            this.aceEditor.selection.setRange(
              new Range(startLine, startCol, endLine, endCol),
            );
          }
        },
      };

      // SAS language server (completions/hover/diagnostics), lazy + additive -
      // ensureLsp() itself gates on aceConfig.lsp and no-ops (resolves null) if
      // the server bundle isn't built or the worker fails to start. Only for
      // ace/mode/sas editors (code editor + a .sas text viewer); other file
      // types opened as text get no LSP, matching the server's languageId.
      this._disposed = false;
      this._lspRegistered = false;
      if (resolvedMode === "ace/mode/sas") {
        ensureLsp().then((provider) => {
          if (!provider || this._disposed) return;
          try {
            provider.registerEditor(this.aceEditor);
            this._lspRegistered = true;
            // Workaround for ace-linters 2.2.0 with completion.overwriteCompleters:
            // false - the LSP completer is merged in alongside ace's own
            // text/keyword/snippet completers, and the popup sorts by score, so
            // push the default completers' scores down so LSP entries list first.
            this.aceEditor.completers = (this.aceEditor.completers || []).map((completer) =>
              Object.assign({}, completer, {
                getCompletions: (ed, session, pos, prefix, callback) => {
                  completer.getCompletions(ed, session, pos, prefix, (err, results) => {
                    (results || []).forEach((r) => {
                      r.score = (r.score || 0) - 1e6;
                    });
                    callback(err, results);
                  });
                },
              }),
            );
            // The semanticTokens/full request ace-linters fires on registration
            // races the server's didOpen handling and fails once; kick a refresh
            // after the server's had time to open the document so the initial
            // view is styled without needing an edit/scroll first.
            setTimeout(() => {
              if (this._disposed) return;
              try {
                provider.$getSessionLanguageProvider(this.aceEditor.session).getSemanticTokens();
              } catch (e) {
                console.warn("[SS Ext] semantic token kick failed:", e);
              }
            }, 2000);
          } catch (e) {
            console.error("[SS Ext] LSP registration failed:", e);
          }
        });
      }
    }

    setupAceEventBindings() {
      this.aceEditor.session.on("change", (delta) => {
        this.triggerEvent("textChanged", { delta });
      });
      this.aceEditor.session.selection.on("changeSelection", () => {
        this.triggerEvent("selectionChanged");
      });
      this.aceEditor.session.selection.on("changeCursor", () => {
        const cursor = this.aceEditor.getCursorPosition();
        this.triggerEvent("caretMoved", {
          data: { line: cursor.row, column: cursor.column },
        });
      });
    }

    triggerEvent(eventName, data) {
      const handlers = this.eventHandlers[eventName] || [];
      handlers.forEach((callback) => {
        try {
          callback.call(this, data);
        } catch (error) {
          console.error(`[SS Ext] Error in ${eventName} handler:`, error);
        }
      });
    }

    // -- Content -------------------------------------------------------------
    getText() {
      return this.aceEditor.getValue();
    }
    setText(content) {
      this.aceEditor.setValue(content || "", -1);
    }
    insert(text) {
      this.aceEditor.insert(text);
    }
    clear() {
      this.aceEditor.setValue("", -1);
    }
    getSelectedText() {
      return this.aceEditor.getSelectedText();
    }
    lineCount() {
      return this.aceEditor.session.getLength();
    }

    // -- Navigation / focus ----------------------------------------------------
    focus() {
      this.aceEditor.focus();
    }
    selectAll() {
      this.aceEditor.selectAll();
    }
    gotoLine(line) {
      this.aceEditor.gotoLine(line);
    }

    // -- Events ----------------------------------------------------------------
    bind(eventName, callback) {
      if (this.eventHandlers[eventName]) {
        this.eventHandlers[eventName].push(callback);
      } else {
        console.warn(`[SS Ext] Unknown editor event: ${eventName}`);
      }
    }
    unbind(eventName, callback) {
      const handlers = this.eventHandlers[eventName];
      if (!handlers) return;
      const index = handlers.indexOf(callback);
      if (index > -1) handlers.splice(index, 1);
    }

    // -- Lifecycle ---------------------------------------------------------------
    activate() {
      /* no-op - Ace doesn't need activation */
    }
    deactivate() {
      /* no-op - Ace doesn't need deactivation */
    }
    dispose() {
      this._disposed = true;
      if (this._lspRegistered && ssExt._lspProvider) {
        // ace-linters' unregisterEditor(editor, cleanupSession) closes the
        // document server-side - must run before aceEditor.destroy() below.
        try {
          ssExt._lspProvider.unregisterEditor(this.aceEditor, true);
        } catch (e) {
          console.error("[SS Ext] LSP unregister failed:", e);
        }
      }
      if (this._darkModeMql) {
        this._darkModeMql.removeEventListener("change", this._darkModeHandler);
      }
      if (this.aceEditor) {
        this.aceEditor.destroy();
      }
      if (this.container) {
        this.container.innerHTML = "";
        this.container.style.width = "";
        this.container.style.height = "";
      }
    }

    // -- Settings (all called by appDMS.applyOptionsToEditor) --------------------
    fontSize(size) {
      if (size !== undefined) this.aceEditor.setFontSize(size);
      return this.aceEditor.getFontSize();
    }
    lineNumber(enable) {
      if (enable !== undefined) this.aceEditor.setOption("showLineNumbers", enable);
      return this.aceEditor.getOption("showLineNumbers");
    }
    syntaxHighlighting() {
      return true; // Ace always highlights
    }
    autoComplete(enable) {
      if (enable !== undefined) {
        this.aceEditor.setOption("enableBasicAutocompletion", enable);
        this.aceEditor.setOption("enableLiveAutocompletion", enable);
      }
      return this.aceEditor.getOption("enableBasicAutocompletion");
    }
    lineWrapped(enable) {
      if (enable !== undefined) this.aceEditor.session.setUseWrapMode(enable);
      return this.aceEditor.session.getUseWrapMode();
    }
    tabSize(size) {
      if (size !== undefined) this.aceEditor.session.setTabSize(size);
      return this.aceEditor.session.getTabSize();
    }
    tabAsSpaces(enable) {
      if (enable !== undefined) this.aceEditor.session.setUseSoftTabs(enable);
      return this.aceEditor.session.getUseSoftTabs();
    }
    readOnly(enable) {
      if (enable !== undefined) this.aceEditor.setReadOnly(enable);
      return this.aceEditor.getReadOnly();
    }

    // Live-apply a { darkTheme, lightTheme, options } config (ssExt.applyAceConfig).
    applyConfig(cfg) {
      this._darkTheme = cfg.darkTheme;
      this._lightTheme = cfg.lightTheme;
      const isDarkMode = this._darkModeMql && this._darkModeMql.matches;
      this.aceEditor.setTheme(isDarkMode ? cfg.darkTheme : cfg.lightTheme);
      this.aceEditor.setOptions(cfg.options);
      // Keep the status bar overlay's font in step with the editor's.
      if (this._statusEl) this._statusEl.style.fontSize = cssFontSize(cfg.options && cfg.options.fontSize);
    }

    // -- Layout ------------------------------------------------------------------
    resize() {
      this.aceEditor.resize();
    }
    resizeOnly() {
      // Not in the base API; checked with `if (editor.resizeOnly)` in several places.
      this.aceEditor.resize();
    }

    // -- Undo/redo ---------------------------------------------------------------
    undo() {
      this.aceEditor.undo();
    }
    redo() {
      this.aceEditor.redo();
    }
    canUndo() {
      return this.aceEditor.session.getUndoManager().hasUndo();
    }
    canRedo() {
      return this.aceEditor.session.getUndoManager().hasRedo();
    }

    // -- Find/replace --------------------------------------------------------------
    showFindReplaceDialog() {
      this.aceEditor.execCommand("find");
    }
    hideFindReplaceDialog() {
      /* no-op */
    }
    showGoToLineDialog() {
      this.aceEditor.execCommand("gotoline");
    }
    hideGoToLineDialog() {
      /* no-op */
    }
    search(key, config) {
      this.aceEditor.find(key, config);
    }
    replace(key, value, config) {
      if (key) this.aceEditor.find(key, config);
      this.aceEditor.replaceAll(value);
    }

    // -- Clipboard (browser handles these natively) ---------------------------------
    cut() {}
    copy() {}
    paste() {}
    canPaste() {
      return true;
    }

    // -- Misc stubs -------------------------------------------------------------------
    getContextMenu() {
      return null;
    }
    setNextFocusHandler() {}
    setPreviousFocusHandler() {}
    setLibService() {}
    promptText() {}
    enableHint() {}
    regShortcuts() {}
    getHTML() {
      // ponytail: plaintext fallback (no ext-static_highlight loaded); good enough
      // for the print/summary consumers, upgrade if syntax-highlighted print matters.
      const div = document.createElement("div");
      div.textContent = this.aceEditor.getValue();
      return div.innerHTML;
    }
  }

  // ==========================================================================
  // Singleton state + public API
  // ==========================================================================
  const ssExt = {
    active: false,
    newAceLoaded: false,
    patchesInstalled: false,
    origLib: null, // { ace }
    newLib: null, // { ace }
    userSnippets: "", // stashed by toggle()/browse() before the ace lib loads
    _userSnippetsParsed: null, // previously-registered parsed snippets, for unregister
    _textViewers: [], // live { pane, tabHolder, adapter, item, textarea, origSet, origResize, editable, dirty, buttons } entries
    libPath: null, // stashed by loadNewAce() so the palette's editor-toggle command can call toggle(ssExt.libPath)
    aceConfig: null, // seeded by sw.js (tabs.onUpdated) and refreshed by applyAceConfig()
    activate,
    deactivate,
    toggle,
    loadNewAce,
    browse,
    commandPalette,
    applySnippets,
    applyAceConfig,
    AceEditorAdapter, // exposed mainly for test/debug (smoke.js probes config seeding directly)
  };
  window.__ssExt = ssExt;

  // ace's fontSize option is a number (px) or a CSS string ("13px"/"11pt"); the
  // status bar overlay wants a CSS font-size string either way.
  function cssFontSize(fs) {
    return typeof fs === "number" ? fs + "px" : fs || "";
  }

  // Ace-settings-panel options that are deliberately NEVER saved into aceConfig:
  // - "theme": persisted as a dark/light PAIR from the options page only (the
  //   panel's single theme knob can't express a pair).
  // - "mode": the language mode is per-file (SAS Studio picks it from the file
  //   type; the SAS editor is always ace/mode/sas) - it must never become a saved
  //   default that would force every editor to one language.
  const NON_PERSISTED_ACE_OPTIONS = ["theme", "mode"];

  // -- Ace editor configuration (theme pair + generic ace options) --------------
  // Fallback mirrors defaults.js's DEFAULT_ACE_CONFIG for the (normally brief)
  // window before sw.js's onUpdated seed sets ssExt.aceConfig - MAIN-world code
  // can't importScripts/load defaults.js itself.
  function getAceConfig() {
    const cfg = ssExt.aceConfig || {};
    return {
      darkTheme: cfg.darkTheme || "ace/theme/gruvbox",
      lightTheme: cfg.lightTheme || "ace/theme/iplastic",
      options: Object.assign(
        { fontSize: 15, keyboardHandler: "ace/keyboard/vim", useSoftTabs: true, tabSize: 4 },
        cfg.options || {},
      ),
    };
  }

  // Called by sw.js's storage.onChanged listener (aceConfig key) and by the
  // settings-menu persistence hook (installSettingsMenuPersistence, below).
  // Stores the config and live-applies it to every open adapter.
  function applyAceConfig(config) {
    ssExt.aceConfig = config;
    if (!ssExt.newAceLoaded) return; // nothing open yet to apply to

    const cfg = getAceConfig();
    const adapters = ssExt._textViewers.map((e) => e.adapter).filter(Boolean);
    if (typeof appDMS !== "undefined" && appDMS.tabs && appDMS.tabs.getAllTabObjects) {
      appDMS.tabs.getAllTabObjects().forEach((t) => {
        const a = t.editor && t.editor.editor;
        if (a && a._isAceEditorAdapter) adapters.push(a);
      });
    }
    adapters.forEach((a) => {
      try {
        a.applyConfig(cfg);
      } catch (e) {
        console.error("[SS Ext] applyAceConfig: failed to apply to an editor:", e);
      }
    });

    // Removed mappings from an earlier vimrc keep applying until page reload
    // (Vim has no "reset to defaults" - only explicit unmap of what we know about).
    const vimrcText = config.vimrc || "";
    if (vimrcText !== ssExt._vimrcLastText) applyVimrcConfig(vimrcText);
  }

  // -- Ace library management ---------------------------------------------------
  // The original ace build's #ace_editor.css/#ace-tm style elements are inert:
  // SAS Studio renders its own editor DOM (EditorView.js) and never references
  // any .ace_* class or calls ace.edit - the vendored ace is only ever used via
  // runtime ace.require(...) for tokenization (Mode.js/SyntaxColorerAdapter.js).
  // So those old style elements are just discarded here (avoids duplicate-rule
  // edge cases once the new build's same-named styles are attached). The
  // window.ace GLOBAL still has to be swapped between builds though, whenever
  // the toggle is inactive - it's the registry those ace.require calls resolve
  // against, and it needs to keep pointing at the version-matched library.

  function backupOrigAce() {
    if (ssExt.origLib) return;
    ["ace_editor.css", "ace-tm"]
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .forEach((el) => el.remove());
    ssExt.origLib = { ace: window.ace };
    delete window.ace;
    Array.from(document.head.querySelectorAll("script[src]"))
      .filter((el) => /\/ace\/.*\.js$/.test(el.src))
      .forEach((el) => el.remove());
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`[SS Ext] Failed to load ${src}`));
      document.body.appendChild(el);
    });
  }

  async function loadNewAce(libPath) {
    ssExt.libPath = libPath;
    if (ssExt.newAceLoaded) return;
    backupOrigAce();

    // lib/ace/ is pristine ace-builds@1.43.3 - the custom SAS mode/snippets and
    // the browse_ss extension live under the extension root's src/ace/ instead
    // (see src/ace-patches.js's header comment for the rest of this split).
    const srcAcePath = libPath.replace(/\/lib\/ace\/src-noconflict$/, "/src/ace");

    await loadScript(`${libPath}/ace.js`);
    if (window.ace && window.ace.config) {
      window.ace.config.set("basePath", libPath);
      // This build resolves "ace/keyboard/<name>" to keyboard-<name>.js, but the
      // bundled files are keybinding-<name>.js - without this override a
      // non-default keyboardHandler (vim, emacs, sublime, vscode - all
      // user-selectable from the options page/settings panel) 404s and silently
      // never loads. Fix the URLs before any editor is created.
      ["vim", "emacs", "sublime", "vscode"].forEach((name) => {
        window.ace.config.setModuleUrl(`ace/keyboard/${name}`, `${libPath}/keybinding-${name}.js`);
      });
      // ace/mode/sas and ace/snippets/sas aren't in lib/ (see above) - point ace's
      // lazy module loader at src/ace/ instead of the basePath default.
      window.ace.config.setModuleUrl("ace/mode/sas", `${srcAcePath}/mode-sas.js`);
      window.ace.config.setModuleUrl("ace/snippets/sas", `${srcAcePath}/snippets-sas.js`);
    }
    // mode-sas.js embeds Ace's own Python/Lua highlight rules for PROC PYTHON/LUA
    // submit;...endsubmit; blocks (require("./python_highlight_rules") etc.), so
    // those modes must already be registered before any editor is created.
    await loadScript(`${libPath}/mode-python.js`);
    await loadScript(`${libPath}/mode-lua.js`);
    // Note: the src-noconflict build only ever assigns window.ace - its internal
    // require/define are closure-local, so window.require/window.define (Dojo's
    // AMD loader) are never touched and don't need swapping either direction.
    // Its #ace_editor.css/#ace-tm style elements stay attached permanently from
    // here on - they're harmless since nothing in SAS Studio references .ace_*.

    await loadScript(`${libPath}/ext-language_tools.js`);
    await loadScript(`${srcAcePath}/ext-browse_ss.js`);
    await loadScript(`${libPath}/ext-prompt.js`);
    await loadScript(`${libPath}/ext-statusbar.js`);

    // Re-apply the fork's source changes now that everything they patch
    // (ace/autocomplete + ace/snippets from ext-language_tools, ace/ext/modelist
    // from ext-prompt, ace/ext/statusbar from ext-statusbar - none are in ace.js
    // core) has loaded. This MUST run before ext-settings_menu.js below: its
    // bundled ace/ext/options snapshots modelist.modes at load time into the
    // settings-menu Mode dropdown, so the SAS entry has to exist first.
    if (window.__ssExtApplyAcePatches) window.__ssExtApplyAcePatches(window.ace);

    // Bundles its own copy of ace/ext/options (OptionPanel) - the stock
    // Ctrl-,/showSettingsMenu panel. Eagerly loading it here means ace core's
    // lazy config.loadModule("ace/ext/settings_menu", ...) in the showSettingsMenu
    // command is a no-op (module id already registered), not a second HTTP load.
    await loadScript(`${libPath}/ext-settings_menu.js`);

    ssExt.newLib = { ace: window.ace };
    ssExt.newAceLoaded = true;

    installSettingsMenuPersistence();
    // Register vim :w/:q/:wq/:x once the new ace (and its vim module) is available.
    installVimExCommands();

    // loadNewAce can run while the toggle is inactive (browse-before-activate);
    // ace.js just clobbered window.ace with the new build, so put the global
    // back on whichever side is actually active.
    window.ace = ssExt.active ? ssExt.newLib.ace : ssExt.origLib.ace;
  }

  // -- User-configurable snippets -------------------------------------------------
  // Additive over ace's built-in SAS snippets - parseSnippetFile + register don't
  // replace anything. ponytail: duplicate triggers appear twice in the completion
  // list; dedupe-by-trigger is the upgrade path if that ever bites someone.
  function applySnippets(text) {
    if (!ssExt.newAceLoaded) return; // nothing to apply against yet
    ssExt.userSnippets = text || "";

    try {
      ssExt.newLib.ace.require("ace/ext/language_tools"); // ensure snippet manager is wired up
      const sm = ssExt.newLib.ace.require("ace/snippets").snippetManager;

      if (ssExt._userSnippetsParsed) {
        sm.unregister(ssExt._userSnippetsParsed, "sas");
        ssExt._userSnippetsParsed = null;
      }

      if (text) {
        const parsed = sm.parseSnippetFile(text);
        sm.register(parsed, "sas");
        ssExt._userSnippetsParsed = parsed;
      }
    } catch (e) {
      console.error("[SS Ext] Failed to apply user snippets:", e);
    }
  }

  // -- SAS language server (LSP) via ace-linters ---------------------------------
  // Additive-only: completions/hover/diagnostics/semantic tokens layer on top of
  // mode-sas's own highlighting; if the (gitignored, built separately by
  // ./build_lib.sh) server bundle is missing or the worker fails, editors
  // just work as before. One worker/LanguageProvider for the page's whole lifetime
  // once started - ponytail: never torn down, deactivate()/reactivate() (the
  // Phase-1 toggle) just re-registers editors against the same provider/worker.

  // Semantic-token overlay colors (ace-linters renders them as CSS marker spans,
  // session.addTextMarker - they don't replace mode-sas's own tokenizer output).
  // The SAS LS legend uses custom token types (proc-name, sec-keyword, macro-*,
  // ...) no ace theme knows, copied from the sas-lsp-demo's index.html.
  const LSP_SEMANTIC_TOKEN_CSS = `
    .ace_proc-name { color: #7a3e9d; font-weight: bold; }
    .ace_sec-keyword { color: #0d7377; }
    .ace_macro-keyword, .ace_macro-sec-keyword { color: #b35c00; }
    .ace_macro-ref { color: #b35c00; font-style: italic; }
    .ace_macro-keyword-param { color: #8a6d00; }
    .ace_macro-comment { color: #948f8f; font-style: italic; }
    .ace_format { color: #275fbf; font-style: italic; }
    .ace_date, .ace_time, .ace_dt { color: #1a7f37; }
    .ace_namelit, .ace_hex, .ace_bitmask { color: #9a3131; }
  `;

  // Returns a promise of the shared LanguageProvider, or null if LSP is disabled/
  // unavailable. Memoized on ssExt._lspStarting so concurrent AceEditorAdapter
  // constructions share one worker/provider instead of racing to start several;
  // a failure sets ssExt._lspFailed permanently so it's never retried in a loop
  // (a page reload is required to try again, e.g. after building the bundle).
  function ensureLsp() {
    if (getAceConfig().lsp === false) return Promise.resolve(null);
    if (ssExt._lspStarting) return ssExt._lspStarting;

    ssExt._lspStarting = (async () => {
      if (ssExt._lspFailed) return null;
      try {
        // Same derivation pattern as loadNewAce's srcAcePath: strip the known
        // suffix off libPath to get back to the extension root.
        const extRoot = ssExt.libPath.replace(/\/lib\/ace\/src-noconflict$/, "");
        const serverUrl = `${extRoot}/lib/sas-lsp/sas-server.js`;

        try {
          const resp = await fetch(serverUrl, { method: "HEAD" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch (e) {
          console.warn("[SS Ext] LSP server bundle not found - run ./build_lib.sh");
          ssExt._lspFailed = true;
          return null;
        }

        // ace-linters' UMD wrapper checks the GLOBAL `define` and takes the AMD
        // branch if it looks like one (`typeof define === "function" &&
        // define.amd`) - Dojo's own loader satisfies that check, so on this page
        // the module would register itself into Dojo's registry instead of
        // setting window.LanguageClient/window.AceLanguageClient. Hide `define`
        // for the two loads so the UMD wrapper falls through to its plain-global
        // branch instead, same trick as ace.js avoiding window.require/define.
        const savedDefine = window.define;
        delete window.define;
        try {
          await loadScript(`${extRoot}/lib/ace-linters/language-client.js`);
          await loadScript(`${extRoot}/lib/ace-linters/ace-language-client.js`);
        } finally {
          if (savedDefine) window.define = savedDefine;
        }

        // Blob + importScripts, not a fetched string: avoids pulling the ~22 MB
        // bundle into a JS string just to hand it back to the Worker constructor.
        const worker = new Worker(
          URL.createObjectURL(
            new Blob([`importScripts(${JSON.stringify(serverUrl)})`], { type: "text/javascript" }),
          ),
        );
        worker.addEventListener("error", (e) => {
          console.warn("[SS Ext] LSP worker error:", (e && e.message) || e);
        });

        // Workaround for ace-linters 2.2.0: its filterByFeature() checks
        // `capabilities.hoverProvider == true`, but the SAS server advertises the
        // LSP-spec-legal object form (e.g. {workDoneProgress: true}), so hover
        // requests are silently never sent. Coerce object-form hoverProvider/
        // documentHighlightProvider to true in the initialize response before
        // ace-linters sees it. Must intercept the `onmessage` ASSIGNMENT (that's
        // how vscode-jsonrpc's BrowserMessageReader attaches) - an
        // addEventListener wrapper would see the message too late to matter.
        let realOnMessage = null;
        Object.defineProperty(worker, "onmessage", {
          get: () => realOnMessage,
          set: (fn) => {
            realOnMessage = fn;
          },
        });
        worker.addEventListener("message", (e) => {
          const caps = e.data && e.data.result && e.data.result.capabilities;
          if (caps) {
            ["hoverProvider", "documentHighlightProvider"].forEach((k) => {
              if (typeof caps[k] === "object" && caps[k] !== null) caps[k] = true;
            });
            ssExt._lspReady = true; // asserted by test/smoke.js
          }
          // The semanticTokens/full request ace-linters fires at registerEditor
          // races the server's didOpen and errors ("reading 'changed'") once per
          // editor; nothing catches the rejection, so it lands in the console as
          // an uncaught ResponseError. Rewrite it into an empty result - a null
          // token set is a clean no-op client-side, and the request refires on
          // every edit/scroll (plus our 2s kick), so nothing is lost.
          // ponytail: matched by method name in the server-built error message -
          // this swallows ALL semanticTokens errors, not just the didOpen race.
          const err = e.data && e.data.error;
          if (err && typeof err.message === "string" && err.message.includes("textDocument/semanticTokens")) {
            delete e.data.error;
            e.data.result = null;
          }
          if (realOnMessage) realOnMessage.call(worker, e);
        });

        const serverData = {
          // UMD builds loaded as classic scripts above (no bundler/dynamic
          // import of a bare specifier) - language-client.js already set
          // window.LanguageClient.
          module: () => Promise.resolve({ LanguageClient: window.LanguageClient }),
          modes: "sas",
          type: "webworker",
          worker,
        };
        const provider = window.AceLanguageClient.for(serverData, {
          functionality: { completion: { overwriteCompleters: false }, semanticTokens: true },
        });
        ssExt._lspProvider = provider;

        if (!ssExt._lspStyleInjected) {
          ssExt._lspStyleInjected = true;
          const style = document.createElement("style");
          style.textContent = LSP_SEMANTIC_TOKEN_CSS;
          document.head.appendChild(style);
        }

        return provider;
      } catch (e) {
        console.error("[SS Ext] LSP setup failed:", e);
        ssExt._lspFailed = true;
        return null;
      }
    })();

    return ssExt._lspStarting;
  }

  // -- One-time SAS.Editor / DMSEditor patches -----------------------------------

  function installPatches() {
    if (ssExt.patchesInstalled) return;

    if (!ssExt.OriginalSASEditor) {
      if (typeof SAS === "undefined" || typeof SAS.Editor === "undefined") {
        console.error("[SS Ext] SAS.Editor not found, cannot install patches");
        return;
      }

      const OriginalSASEditor = SAS.Editor;
      ssExt.OriginalSASEditor = OriginalSASEditor;

      function EditorDispatcher(containerId, content, langMode) {
        return ssExt.active
          ? new AceEditorAdapter(containerId, content, langMode)
          : new OriginalSASEditor(containerId, content, langMode);
      }
      Object.keys(OriginalSASEditor).forEach((key) => {
        EditorDispatcher[key] = OriginalSASEditor[key];
      });
      SAS.Editor = EditorDispatcher;
    }

    installCreateFileViewPatch();

    const tabs = appDMS.getCurrentPerspectiveSASStudioTabs();
    installTextViewerCloseConfirm(tabs);
    let DMSEditor = null;
    if (tabs && tabs.mainTabs) {
      for (const tab of tabs.mainTabs) {
        if (tab.editor) {
          DMSEditor = tab.editor.constructor;
          break;
        }
      }
    }

    if (!DMSEditor || !DMSEditor.prototype.createCodeEditor) {
      console.warn("[SS Ext] Could not find DMSEditor class to patch");
      return;
    }

    if (DMSEditor.prototype._aceReplacementPatched) {
      ssExt.patchesInstalled = true;
      return;
    }

    const originalCreateCodeEditor = DMSEditor.prototype.createCodeEditor;
    ssExt.originalCreateCodeEditor = originalCreateCodeEditor;

    DMSEditor.prototype.createCodeEditor = function () {
      if (!ssExt.active) {
        return originalCreateCodeEditor.call(this);
      }

      // Ace path, ported from the original one-shot patch to createCodeEditor.
      if (!this.editorDiv || !this.editorDiv.id) {
        throw new Error("[SS Ext] editorDiv not found on DMSEditor instance");
      }

      if (this.fileType === "CPK" && this.editorContent && this.editorContent.length > 0) {
        this.setPackage(this.editorContent);
      }

      this.editor = new AceEditorAdapter(
        this.editorDiv.id,
        this.editorContent,
        aceModeFor(this.name),
      );
      this.editor.log = this.logAreaContentPane;

      if (appDMS.currentPerspectiveKey === "interactivePP") {
        this.editor.readOnly(true);
      }

      appDMS.applyOptionsToEditor(this.editor);

      try {
        const contextMenu = this.editor.getContextMenu();
        if (contextMenu && contextMenu.removeItems && contextMenu.insertItems) {
          const lang = require("dojo/_base/lang");
          contextMenu.removeItems(11, 2);
          contextMenu.removeItems(9, 2);
          contextMenu.insertItems(9, [
            {
              type: "entry",
              label: this.resourceBundle.gotoToolbarLabel,
              onClick: lang.hitch(this, this.setPreviousFocus),
            },
            {
              type: "entry",
              label: this.resourceBundle.goToLogLabel,
              onClick: lang.hitch(this, this.setNextFocus),
            },
          ]);
        }
      } catch (e) {
        console.warn("[SS Ext] Could not customize context menu:", e);
      }

      const lang = require("dojo/_base/lang");
      this.editor.bind("textChanged", lang.hitch(this, this.editorChanged));
      this.editor.bind("selectionChanged", lang.hitch(this, this.selectionChanged));
      this.editor.bind("caretMoved", lang.hitch(this, this.caretMoved));

      this.setButtonStates();
      this.editor.gotoLine(1);
      setTimeout(lang.hitch(this, this.setInitialFocus), 100);
      this.setGoToLineConstraints();

      if (this.editor.bind && window.appDMS && window.appDMS.dropFromDesktop) {
        this.editor.bind("drop", window.appDMS.dropFromDesktop);
      }
      if (this.editor.setLibService && this.getLibList) {
        this.editor.setLibService(this.getLibList);
      }

      this.editor.activate();
      this.setFinalized(true);
    };

    DMSEditor.prototype._aceReplacementPatched = true;
    ssExt.patchesInstalled = true;
  }

  // -- "View file as text" -> read-only Ace ----------------------------------------
  // AppDMS.createFileView (AppDMS.js:4248) always builds a read-only SimpleTextarea
  // for TXT/LOG/etc. viewers. The load/refresh flows navigate to it POSITIONALLY,
  // not via tabHolder.simpleTextArea:
  //   - perspectiveFileOpen refresh guard (AppDMS.js:3927-3932):
  //       pane.getChildren()[1].getChildren()[0].value
  //   - xhr load handler (AppDMS.js:3979-3985):
  //       this.getChildren()[1].getChildren()[0].set("value", data)  (falls back
  //       to this.tabHolder.simpleTextArea.set("value", data) only if that path
  //       is absent)
  // A shim that isn't a real widget in the tree breaks both: destroying the
  // widget leaves getChildren()[0] undefined, so `.value` throws before the busy
  // dialog is hidden (forever-spinner) and the load's `.set("value", data)`
  // never happens (empty editor). Fix: keep the real SimpleTextarea alive and in
  // the widget tree, hide it visually, and mirror its value writes into Ace.
  function installCreateFileViewPatch() {
    if (ssExt._createFileViewPatched) return;
    if (typeof appDMS.createFileView !== "function") return;

    const originalCreateFileView = appDMS.createFileView.bind(appDMS);
    ssExt.originalCreateFileView = originalCreateFileView;

    appDMS.createFileView = function (item, targetComponent, content, paneId) {
      const tabHolder = originalCreateFileView(item, targetComponent, content, paneId);
      if (ssExt.active) {
        try {
          convertTextViewerToAce(item, tabHolder);
        } catch (e) {
          console.error("[SS Ext] Failed to convert text viewer to Ace:", e);
        }
      }
      return tabHolder;
    };
    ssExt._createFileViewPatched = true;
  }

  // Text viewers never get a `.editor` on their tab object (only DMSEditor.js's
  // real code editor sets that - AppDMS.createFileView doesn't), so SASStudioTabs'
  // own _getCloseAdapter/_onTabClose never see them as dirty and close them
  // without asking, unlike a real code editor tab. Patch the shared prototype
  // method once to check our own _textViewers dirty tracking and, if dirty, show
  // the same stock save/don't-save/cancel dialog the code editor uses.
  function installTextViewerCloseConfirm(tabs) {
    if (ssExt._closeConfirmPatched) return;
    const proto = Object.getPrototypeOf(tabs);
    if (typeof proto._onTabClose !== "function") return;

    const original = proto._onTabClose;
    proto._onTabClose = function (tabObj) {
      const entry = ssExt._textViewers.find((e) => e.tabHolder === tabObj.tab.tabHolder);
      if (entry && entry.dirty) {
        this._postFileCloseConfirmation(tabObj.tab, {
          isDirty: () => entry.dirty,
          isRunning: () => false,
          resetDirty: () => setViewerDirty(entry, false),
          save: () => saveTextViewer(entry, () => this.closeTab(tabObj)),
        });
        return false;
      }
      return original.call(this, tabObj);
    };
    ssExt._closeConfirmPatched = true;
  }

  function convertTextViewerToAce(item, tabHolder) {
    const pane = tabHolder.textContainer;
    const textarea = tabHolder.simpleTextArea;
    if (textarea && textarea.domNode) textarea.domNode.style.display = "none";

    const divId = `ssf_textviewer_${pane.id}`;
    const div = document.createElement("div");
    div.id = divId;
    div.style.width = "100%";
    div.style.height = "100%";
    pane.domNode.appendChild(div);

    const adapter = new AceEditorAdapter(
      divId,
      textarea ? textarea.get("value") : "",
      aceModeFor(item && item.name),
    );
    // Always editable (like a normal editor); the dirty state drives the tab
    // marker and Save button, and Ctrl/Cmd+S / vim :w save.
    adapter.readOnly(false);

    const entry = {
      pane,
      tabHolder,
      adapter,
      item,
      textarea,
      origSet: null,
      origResize: null,
      dirty: false,
      _suppressDirty: false,
      baseLabel: null, // captured lazily from the tab control button on first dirty
      buttons: {},
    };

    // Mirror server writes (load + refresh, both positional and via
    // tabHolder.simpleTextArea) into Ace without touching the widget's own
    // value storage - the positional `.value` reads still see the real thing.
    if (textarea) {
      const origSet = textarea.set.bind(textarea);
      entry.origSet = origSet;
      textarea.set = function (name, val) {
        const r = origSet(name, val);
        if (name === "value") {
          entry._suppressDirty = true;
          adapter.setText(val == null ? "" : val);
          entry._suppressDirty = false;
          // A full server write (initial load or Refresh) is the clean baseline:
          // clear any prior dirty state, drop the tab marker, disable Save.
          setViewerDirty(entry, false);
        }
        return r;
      };
    }

    const origResize = pane.resize;
    entry.origResize = origResize;
    pane.resize = function (...args) {
      const result = origResize.apply(this, args);
      adapter.resize();
      return result;
    };

    adapter.bind("textChanged", () => {
      if (entry._suppressDirty) return;
      setViewerDirty(entry, true);
    });

    // Ctrl/Cmd+S saves, same as the code editor. An Ace command intercepts and
    // preventDefaults the browser's own save dialog.
    adapter.aceEditor.commands.addCommand({
      name: "ssfSaveTextViewer",
      bindKey: { win: "Ctrl-S", mac: "Command-S" },
      exec: () => saveTextViewer(entry),
    });

    ssExt._textViewers.push(entry);

    // Leak safety: dijit destroys the ContentPane's dijit children on tab close
    // but knows nothing about the adapter - own() runs our cleanup alongside it.
    // Guarded by array membership so a later restoreTextViewers() (deactivate)
    // doesn't get double-disposed when the pane is eventually closed for real.
    pane.own({
      destroy() {
        const idx = ssExt._textViewers.indexOf(entry);
        if (idx === -1) return;
        adapter.dispose();
        ssExt._textViewers.splice(idx, 1);
      },
    });

    // Toolbar Save button - only TXT/LOG viewers get a toolbar (AppDMS.js:4247-4262).
    // Other file types that fall through to createFileView still get an editable
    // Ace viewer with mirrored content (Ctrl+S / vim :w still save), just no button.
    const toolbar = dijit.byId(`${appDMS.currentPerspectiveKey}_${item.id}_texttoolbar`);
    if (toolbar) {
      entry.buttons.save = makeSaveButton(entry);
      toolbar.addChild(entry.buttons.save);
    }
  }

  // Tab control button widget for a viewer, resolved via its tabHolder (the tab
  // object's .tab.tabHolder is the same object we hold in the entry).
  function viewerTabControlButton(entry) {
    const tabObj = appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.tab && t.tab.tabHolder === entry.tabHolder);
    return tabObj && tabObj.tab && tabObj.tab.controlButton;
  }

  // Reflect dirty state into the Save button and the tab title marker, matching
  // the code editor's "*name" convention (DMSEditor.applyChangedIndicationToTab).
  function setViewerDirty(entry, dirty) {
    entry.dirty = dirty;
    if (entry.buttons.save) entry.buttons.save.set("disabled", !dirty);
    const btn = viewerTabControlButton(entry);
    if (btn && btn.containerNode) {
      if (entry.baseLabel == null) {
        entry.baseLabel = btn.containerNode.textContent.replace(/^\*/, "");
      }
      const label = (dirty ? "*" : "") + entry.baseLabel;
      btn.containerNode.innerHTML = appDMS.encodeHtml ? appDMS.encodeHtml(label) : label;
    }
  }

  function makeSaveButton(entry) {
    return new dijit.form.Button({
      iconClass: "sasSaveIcon",
      label: "Save",
      showLabel: false,
      disabled: true,
      onClick() {
        saveTextViewer(entry);
      },
    });
  }

  // Minimal mirror of DMSEditor.prototype.saveFile's core POST (DMSEditor.js
  // ~6791-6976) - just the plain "workspace" save path. No autosave/backup
  // cleanup (viewers never created a backup file), no MVS/ftp/CTK/CPK branches,
  // since text viewers only ever come from plain workspace files.
  function saveTextViewer(entry, onSaved) {
    const uri = entry.item && entry.item.uri;
    if (!uri) {
      console.error("[SS Ext] Cannot save text viewer: no item.uri", entry.item);
      if (typeof dojoAlert === "function") dojoAlert("Save failed: no file URI");
      else alert("Save failed: no file URI");
      return;
    }

    let url =
      appDMS.baseURL +
      "/sasexec/sessions/" +
      appDMS.sessionId +
      "/workspace/" +
      encodeValue(uri, false, "/", false);
    const encoding = entry.item.encoding;
    if (typeof encoding === "string" && encoding) url += "?encoding=" + encoding;

    dojo.xhrPost({
      postData: entry.adapter.getText(),
      url,
      contentType: "text/file",
      handleAs: "json",
      headers: { ObjectType: "" },
      preventCache: true,
      load: () => {
        setViewerDirty(entry, false);
        if (onSaved) onSaved();
      },
      error: (err) => {
        // DMSEditor treats HTTP 499 as a successful save too.
        if (err && err.status === 499) {
          setViewerDirty(entry, false);
          if (onSaved) onSaved();
          return;
        }
        try {
          dojoAlert(err.response.xhr.getResponseHeader("Exception"));
        } catch (_) {
          alert("Save failed");
        }
      },
    });
  }

  // -- Vim :w / :q / :wq / :x ------------------------------------------------------
  // Registered once on the shared vim module (ace/keyboard/vim), so they apply to
  // every vim-mode Ace instance - text viewers and the code editors alike. The Ex
  // handler gets `cm.ace` (the acting Ace editor); resolve it back to either a text
  // viewer entry or a DMSEditor code tab and save/close accordingly.
  function resolveAceContext(aceEditor) {
    const viewer = ssExt._textViewers.find((e) => e.adapter && e.adapter.aceEditor === aceEditor);
    if (viewer) return { type: "viewer", entry: viewer };
    const tabObj = appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor === aceEditor);
    if (tabObj) return { type: "code", tabObj };
    return null;
  }

  function vimSave(ctx) {
    if (!ctx) return;
    if (ctx.type === "viewer") saveTextViewer(ctx.entry);
    else if (ctx.tabObj.editor.saveFile) ctx.tabObj.editor.saveFile();
  }

  function vimClose(ctx) {
    if (!ctx) return;
    const tabObj =
      ctx.type === "viewer"
        ? appDMS.tabs.getAllTabObjects().find((t) => t.tab && t.tab.tabHolder === ctx.entry.tabHolder)
        : ctx.tabObj;
    if (tabObj) appDMS.tabs.closeTab(tabObj);
  }

  function installVimExCommands() {
    if (ssExt._vimExInstalled) return;
    ssExt._vimExInstalled = true; // guard now so concurrent loads don't double-register
    ssExt.newLib.ace.config.loadModule("ace/keyboard/vim", (vim) => {
      const Vim = vim && vim.Vim;
      if (!Vim || !Vim.defineEx) {
        ssExt._vimExInstalled = false;
        return;
      }
      const saveAndClose = (cm) => {
        const ctx = resolveAceContext(cm.ace);
        vimSave(ctx);
        vimClose(ctx);
      };
      Vim.defineEx("write", "w", (cm) => vimSave(resolveAceContext(cm.ace)));
      Vim.defineEx("quit", "q", (cm) => vimClose(resolveAceContext(cm.ace)));
      Vim.defineEx("wq", "wq", saveAndClose);
      Vim.defineEx("xit", "x", saveAndClose);

      const vimrcText = (ssExt.aceConfig && ssExt.aceConfig.vimrc) || "";
      vimrcText.split("\n").forEach((line) => applyVimrcLine(Vim, line));
      ssExt._vimrcApplied = (ssExt._vimrcApplied || 0) + 1;
      ssExt._vimrcLastText = vimrcText;
    });
  }

  function restoreTextViewers() {
    // ponytail: viewers opened while INACTIVE were never converted, so they stay
    // original editors - activation only affects viewers opened afterwards.
    const entries = ssExt._textViewers.splice(0, ssExt._textViewers.length);
    entries.forEach((entry) => {
      const { pane, adapter, textarea, origSet, origResize, buttons } = entry;
      try {
        // Clear the dirty "*" marker from the tab title before we let go.
        if (entry.dirty && entry.baseLabel != null) {
          const btn = viewerTabControlButton(entry);
          if (btn && btn.containerNode) {
            btn.containerNode.innerHTML = appDMS.encodeHtml
              ? appDMS.encodeHtml(entry.baseLabel)
              : entry.baseLabel;
          }
        }

        adapter.dispose();

        const div = document.getElementById(`ssf_textviewer_${pane.id}`);
        if (div) div.remove();

        if (textarea) {
          if (origSet) textarea.set = origSet;
          if (textarea.domNode) textarea.domNode.style.display = "";
        }
        pane.resize = origResize;

        if (buttons.save) buttons.save.destroy();
      } catch (e) {
        console.error("[SS Ext] Failed to restore text viewer:", e);
      }
    });
  }

  // -- Per-tab swap ---------------------------------------------------------------

  function swapTabsToAce() {
    let swapped = 0;
    const tabs = appDMS.getCurrentPerspectiveSASStudioTabs();
    if (!tabs || !tabs.mainTabs) return swapped;

    const lang = require("dojo/_base/lang");

    tabs.mainTabs.forEach((tabObj) => {
      const dmsEditor = tabObj.editor;
      if (!dmsEditor || !dmsEditor.editor || !dmsEditor.editorDiv) return;

      const oldEditor = dmsEditor.editor;
      if (oldEditor._isAceEditorAdapter) return;

      let content = "";
      try {
        content = oldEditor.getText();
      } catch (e) {
        console.warn("[SS Ext] Could not read text from original editor:", e);
      }

      try {
        const newEditor = new AceEditorAdapter(
          dmsEditor.editorDiv.id,
          content,
          aceModeFor(dmsEditor.name),
        );
        dmsEditor.editor = newEditor;

        newEditor.bind("textChanged", lang.hitch(dmsEditor, dmsEditor.editorChanged));
        newEditor.bind("selectionChanged", lang.hitch(dmsEditor, dmsEditor.selectionChanged));
        newEditor.bind("caretMoved", lang.hitch(dmsEditor, dmsEditor.caretMoved));

        if (typeof appDMS.applyOptionsToEditor === "function") {
          appDMS.applyOptionsToEditor(newEditor);
        }
        swapped++;
      } catch (e) {
        console.error("[SS Ext] Failed to swap tab to Ace:", e);
      }
    });

    return swapped;
  }

  function restoreTabsToOriginal() {
    let restored = 0;
    const tabs = appDMS.getCurrentPerspectiveSASStudioTabs();
    if (!tabs || !tabs.mainTabs) return restored;

    tabs.mainTabs.forEach((tabObj) => {
      const dmsEditor = tabObj.editor;
      const adapter = dmsEditor && dmsEditor.editor;
      if (!adapter || !adapter._isAceEditorAdapter) return;

      try {
        // Capture state. Undo history is intentionally dropped in both directions.
        const text = adapter.getText();
        const cursor = adapter.aceEditor.getCursorPosition();
        const wasDirty = dmsEditor.editorContentChanged;

        adapter.dispose(); // destroys ace instance, clears container in place

        dmsEditor.editorContent = text;
        dmsEditor.createCodeEditor(); // dispatcher routes to the original method

        // createCodeEditor doesn't touch editorContentChanged itself, but restore
        // it explicitly as a safety net against future changes to that method.
        dmsEditor.editorContentChanged = wasDirty;

        try {
          dmsEditor.editor.gotoLine(cursor.row + 1); // 1-indexed, also scrolls
          if (dmsEditor.editor.ctrl_ && dmsEditor.editor.ctrl_.selection) {
            dmsEditor.editor.ctrl_.selection(cursor.row, cursor.column);
          }
        } catch (e) {
          console.warn("[SS Ext] Could not restore cursor position:", e);
        }

        restored++;
      } catch (e) {
        console.error("[SS Ext] Failed to restore tab to original editor:", e);
      }
    });

    return restored;
  }

  // -- Public API -------------------------------------------------------------------

  async function activate(libPath) {
    if (ssExt.active) return { active: true };

    await loadNewAce(libPath);
    applySnippets(ssExt.userSnippets);
    // Global still needs to point at the tokenizer's ace.require registry.
    window.ace = ssExt.newLib.ace;
    ssExt.active = true;
    installPatches();

    const swapped = swapTabsToAce();
    console.log(`[SS Ext] activated Ace editor, ${swapped} tab(s) swapped`);
    return { active: true };
  }

  async function deactivate() {
    if (!ssExt.active) return { active: false };

    ssExt.active = false;
    // Global still needs to point at the tokenizer's ace.require registry.
    window.ace = ssExt.origLib.ace;

    const restored = restoreTabsToOriginal();
    restoreTextViewers();
    console.log(`[SS Ext] deactivated Ace editor, ${restored} tab(s) restored`);
    return { active: false };
  }

  function toggle(libPath, snippetsText) {
    if (snippetsText !== undefined) ssExt.userSnippets = snippetsText;
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(
      () => (ssExt.active ? deactivate() : activate(libPath)),
      () => (ssExt.active ? deactivate() : activate(libPath)),
    );
    // Reflect the new state in the toolbar badge for in-page toggles (command
    // palette etc.). MAIN world can't call chrome.action, so hop through
    // relay.js -> sw.js. (The popup also sets the badge itself for its toggles;
    // setting it twice to the same value is harmless.)
    ssExt._pending.then(
      (r) => window.postMessage({ __ssextBadge: !!(r && r.active) }, "*"),
      () => {},
    );
    return ssExt._pending;
  }

  async function doBrowse(kind) {
    if (!ssExt.libPath) {
      console.error("[SS Ext] browse: no libPath known yet - can't load the Ace library");
      return { active: ssExt.active };
    }
    // browse only needs the new ace lib loaded (its css stays attached
    // permanently once loaded) - it doesn't need activation of the editor
    // replacement itself. loadNewAce no-ops if already loaded.
    await loadNewAce(ssExt.libPath);
    applySnippets(ssExt.userSnippets);
    // Resolve through the NEW ace instance, not window.ace - the global is the
    // original library whenever the toggle is off.
    const browseSsModule = ssExt.newLib && ssExt.newLib.ace.require("ace/ext/browse_ss");
    const method = browseSsModule && browseSsModule.browse_ss && browseSsModule.browse_ss["browse_" + kind];
    if (typeof method !== "function") {
      console.error(`[SS Ext] browse_ss.browse_${kind} not found`);
      return { active: ssExt.active };
    }
    method();
    return { active: ssExt.active };
  }

  function browse(kind, libPath, snippetsText) {
    // libPath optional once ssExt.libPath is known (seeded by sw.js on page load),
    // so the in-page browse hotkeys/palette entries can call browse(kind) no-arg.
    if (libPath) ssExt.libPath = libPath;
    if (snippetsText !== undefined) ssExt.userSnippets = snippetsText;
    // Serialize through the same _pending chain as toggle() so browse can't
    // race a concurrent toggle/activation.
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(
      () => doBrowse(kind),
      () => doBrowse(kind),
    );
    return ssExt._pending;
  }

  // -- Command palette ------------------------------------------------------------

  // Find the Ace editor focused when the palette is about to open, if any: text
  // viewers first, then code-editor tabs. Returns null if nothing is focused (or
  // nothing is an Ace instance at all, e.g. the toggle was never activated).
  function focusedAceEditor() {
    const viewer = ssExt._textViewers.find(
      (e) => e.adapter && e.adapter.aceEditor && e.adapter.aceEditor.isFocused(),
    );
    if (viewer) return viewer.adapter.aceEditor;

    if (typeof appDMS !== "undefined" && appDMS.tabs && appDMS.tabs.getAllTabObjects) {
      const tabObj = appDMS.tabs
        .getAllTabObjects()
        .find(
          (t) =>
            t.editor &&
            t.editor.editor &&
            t.editor.editor.aceEditor &&
            t.editor.editor.aceEditor.isFocused(),
        );
      if (tabObj) return tabObj.editor.editor.aceEditor;
    }

    return null;
  }

  // -- Stock Ace settings panel (Ctrl-,/showSettingsMenu) persistence ------------
  // ext-settings_menu.js bundles its own "ace/ext/options" module (OptionPanel) -
  // that's the one showSettingsMenu's exec actually instantiates, so patching
  // this module's prototype (rather than a separately-loaded ext-options.js copy)
  // is what the stock panel is guaranteed to go through. Every user change funnels
  // through OptionPanel.prototype.setOption, which already _signal("setOption")s
  // after running - patch once, after the original, and persist as the default
  // for new editors (live-applied to open ones too). Theme/mode are skipped: the
  // dark/light pair is options-page-only (the panel's single "theme" knob can't
  // express a pair), and "mode" isn't part of the persisted config at all.
  function installSettingsMenuPersistence() {
    if (ssExt._settingsMenuPatched) return;
    ssExt._settingsMenuPatched = true;
    try {
      const OptionPanel = ssExt.newLib.ace.require("ace/ext/options").OptionPanel;
      const origSetOption = OptionPanel.prototype.setOption;
      OptionPanel.prototype.setOption = function (option, value) {
        origSetOption.call(this, option, value);
        if (NON_PERSISTED_ACE_OPTIONS.includes(option.path)) return; // never persist theme/mode
        const cfg = getAceConfig();
        cfg.options[option.path] = value;
        applyAceConfig(cfg);
        window.postMessage({ __ssextAceConfig: cfg }, "*");
      };
    } catch (e) {
      console.error("[SS Ext] Failed to hook settings menu persistence:", e);
    }
  }

  // -- vimrc: a small subset of vim-config lines applied to the shared Vim module -
  // one mapping per line, `"` comments, blank lines skipped. Unsupported syntax
  // just warns and moves on - one bad line shouldn't break the rest.
  //   map/nmap/imap/vmap <lhs> <rhs>        -> Vim.map(lhs, rhs, ctx)
  //   noremap/nnoremap/inoremap/vnoremap    -> Vim.noremap(lhs, rhs, ctx)
  //   unmap/nunmap/iunmap/vunmap <lhs>      -> Vim.unmap(lhs, ctx)
  const VIMRC_CTX = { n: "normal", i: "insert", v: "visual" };

  function applyVimrcLine(Vim, line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '"') return;

    let m = trimmed.match(/^(n|i|v)?(nore)?map\s+(\S+)\s+(\S+)$/);
    if (m) {
      const ctx = m[1] ? VIMRC_CTX[m[1]] : undefined;
      try {
        if (m[2]) Vim.noremap(m[3], m[4], ctx);
        else Vim.map(m[3], m[4], ctx);
      } catch (e) {
        console.error("[SS Ext] vimrc: failed to apply mapping:", trimmed, e);
      }
      return;
    }

    m = trimmed.match(/^(n|i|v)?unmap\s+(\S+)$/);
    if (m) {
      const ctx = m[1] ? VIMRC_CTX[m[1]] : undefined;
      try {
        Vim.unmap(m[2], ctx);
      } catch (e) {
        console.error("[SS Ext] vimrc: failed to unmap:", trimmed, e);
      }
      return;
    }

    console.warn("[SS Ext] vimrc: unsupported line:", trimmed);
  }

  // Applies once the vim module is actually loaded/available; a counter (not
  // just a flag) so smoke tests can see a re-apply happened.
  function applyVimrcConfig(text) {
    if (!ssExt.newAceLoaded) return;
    ssExt.newLib.ace.config.loadModule("ace/keyboard/vim", (vim) => {
      const Vim = vim && vim.Vim;
      if (!Vim) return;
      (text || "").split("\n").forEach((line) => applyVimrcLine(Vim, line));
      ssExt._vimrcApplied = (ssExt._vimrcApplied || 0) + 1;
      ssExt._vimrcLastText = text || "";
    });
  }

  // -- Command palette (built on ace/ext/prompt's generic prompt()) -------------

  function hotkeyHint(hotkey) {
    if (!hotkey || !hotkey.key) return "";
    let name = hotkey.key;
    name = (hotkey.altKey ? "Alt+" : "") + name;
    name = (hotkey.metaKey ? "Meta+" : "") + name;
    name = (hotkey.ctrlKey ? "Ctrl+" : "") + name;
    return name;
  }

  // "gotoline" -> "Gotoline", "openCommandPalette" -> "Open command palette"
  // (same display normalization as prompt.commands in ext-prompt.js).
  function normalizeName(name) {
    return (name || "")
      .replace(/^./, (x) => x.toUpperCase())
      .replace(/[a-z][A-Z]/g, (x) => x[0] + " " + x[1].toLowerCase());
  }

  // Mirrors prompt.commands' getEditorCommandsByName (ext-prompt.js): walks
  // editor.keyBinding.$handlers, dedupes by command name, concatenates keys
  // for a command bound in multiple handlers.
  function getEditorCommandsByName(editor) {
    // browseSs* are added to every editor via ace default_commands (ext-browse_ss.js),
    // but the palette already lists them globally as "SS-Ext: Browse ..." entries, so
    // drop them from the per-editor command list to avoid duplication.
    const excludeCommands = [
      "insertstring",
      "inserttext",
      "setIndentation",
      "paste",
      "browseSsFiles",
      "browseSsLibrary",
      "browseSsTabs",
    ];
    const commandMap = {};
    const commandsByName = [];
    (editor.keyBinding.$handlers || []).forEach((handler) => {
      const platform = handler.platform;
      const byName = handler.byName || {};
      Object.keys(byName).forEach((name) => {
        const cmd = byName[name];
        let key = cmd.bindKey;
        if (typeof key !== "string") key = (key && key[platform]) || "";
        const description = cmd.description || normalizeName(cmd.name || name);
        const cmds = Array.isArray(cmd) ? cmd : [cmd];
        cmds.forEach((command) => {
          const cname = typeof command === "string" ? command : command.name;
          if (!cname || excludeCommands.indexOf(cname) !== -1) return;
          if (commandMap[cname]) {
            commandMap[cname].key += "|" + key;
          } else {
            commandMap[cname] = { key, command: cname, description };
            commandsByName.push(commandMap[cname]);
          }
        });
      });
    });
    return commandsByName;
  }

  // Builds the palette's entries (plain data, JSON-clonable - prompt.commands'
  // getCompletions clones them) plus a side-table of runners keyed by
  // entry.command, since functions don't survive that clone.
  function buildPaletteEntries(focusedEditor) {
    const runners = {};
    const entries = [];

    // toggleEditor + toggleNativeMouse are SSF_TOOLS actions, so they come through
    // this loop like everything else (no special-casing needed).
    (window.SSF_TOOLS || [])
      .filter((t) => t.kind === "action")
      .forEach((tool) => {
        const key = "ssext:" + tool.name;
        runners[key] = () => window.__ssf.run(tool.name);
        entries.push({ value: "SS-Ext: " + tool.label, meta: hotkeyHint(tool.hotkey), command: key });
      });

    if (focusedEditor) {
      getEditorCommandsByName(focusedEditor).forEach((c) => {
        if (runners[c.command]) return; // don't shadow an SS-Ext entry (unlikely)
        runners[c.command] = () => focusedEditor.execCommand(c.command);
        entries.push({ value: c.description, meta: c.key, command: c.command });
      });
    }

    return { entries, runners };
  }

  function openCommandPalette(focusedEditor) {
    const { entries, runners } = buildPaletteEntries(focusedEditor);
    // Stashed for test/debug visibility - not read by any runtime code path.
    window.__ssCmdPalette_lastList = entries;

    const FilteredList = ssExt.newLib.ace.require("ace/autocomplete").FilteredList;
    ssExt.newLib.ace.require("ace/ext/prompt").prompt(focusedEditor || null, "", {
      name: "commands",
      selection: [0, Number.MAX_VALUE],
      onAccept: function (data) {
        const runner = data.item && data.item.command && runners[data.item.command];
        if (!runner) return;
        try {
          runner();
        } catch (e) {
          console.error("[SS Ext] command palette command failed:", e);
        }
      },
      getPrefix: function (cmdLine) {
        const currentPos = cmdLine.getCursorPosition();
        return cmdLine.getValue().substring(0, currentPos.column);
      },
      getCompletions: function (cmdLine) {
        const prefix = this.getPrefix(cmdLine);
        // Clone like prompt.commands does - FilteredList mutates its input.
        const cloned = JSON.parse(JSON.stringify(entries));
        const filtered = new FilteredList(cloned).filterCompletions(cloned, prefix);
        return filtered.length > 0 ? filtered : [{ value: "No matching commands", error: 1 }];
      },
    });
  }

  async function doCommandPalette() {
    // Detect the focused editor BEFORE loading/opening the palette - opening the
    // palette itself moves focus to the prompt's command line.
    const focusedEditor = focusedAceEditor();

    if (!ssExt.libPath) {
      console.error("[SS Ext] commandPalette: no libPath known yet - can't load the Ace library");
      return;
    }
    await loadNewAce(ssExt.libPath);
    applySnippets(ssExt.userSnippets);

    openCommandPalette(focusedEditor);
  }

  function commandPalette(libPath) {
    if (libPath) ssExt.libPath = libPath;
    // Serialize through the same _pending chain as toggle()/browse() so it can't
    // race a concurrent toggle/activation.
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(doCommandPalette, doCommandPalette);
    return ssExt._pending;
  }
})();
