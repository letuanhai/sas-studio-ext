/**
 * SAS Studio editor toggle: swap the built-in editor for Ace, and back again.
 *
 * Injected into the page's MAIN world by sw.js on every toolbar click. Idempotent —
 * a second injection is a no-op because of the `window.__ssExt` guard below; the sw
 * then calls `window.__ssExt.toggle(libPath)` to actually flip state.
 */
(function () {
  "use strict";

  if (window.__ssExt) return;

  // OUR ace library, set by doLoadNewAce() once lib/ace/src-noconflict/ace.js has
  // run. It exports itself as window.__ssAce, never window.ace: that global is
  // SAS Studio's own 1.x ace and stays untouched (see the "Ace library
  // management" section below). Everything in this file that says `ace` means
  // this one, and every user of it runs after loadNewAce() has resolved.
  let ace = null;

  // ==========================================================================
  // AceEditorAdapter - implements the SAS.Editor API on top of Ace
  //
  // Known-stubbed methods (audited against SAS Studio's own callers - only DMSEditor
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
      // SAS Studio uniquifies tab titles by appending " <n>" (SASStudioTabs'
      // _incrementTitle), and that title is what the tab's `name` ends up being -
      // so a "run.log" tab is really called "run.log 1" and the extension is no
      // longer at the end. Drop the counter before asking modelist.
      const m = ace.require("ace/ext/modelist").getModeForPath(name.replace(/ \d+$/, "")).mode;
      if (m && m !== "ace/mode/text") return m;
    } catch (e) {}
    return "ace/mode/sas";
  }

  class AceEditorAdapter {
    // filePath is the file's path on the SAS server (item.uri), when there is
    // one. It becomes the LSP document's URI instead of ace-linters' default
    // "file:///<ace session id>.lua", which is what lets the Lua server work out
    // a module name for it - see _maybeRegisterLsp.
    constructor(containerId, content, modeId, filePath) {
      this.containerId = containerId;
      this._filePath = filePath || null;
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
      const editorTheme = prefersDarkTheme() ? this._darkTheme : this._lightTheme;

      const resolvedMode =
        typeof modeId === "string" && modeId.startsWith("ace/mode/") ? modeId : "ace/mode/sas";
      this._resolvedMode = resolvedMode; // read by setupAceEventBindings below
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
      this._darkModeHandler = () => {
        // Deliberately not event.matches: with darkMode "on" the editor stays
        // dark regardless of which way the OS just flipped.
        this.aceEditor.setTheme(prefersDarkTheme() ? this._darkTheme : this._lightTheme);
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
      // Diff commands: registered on every editor, whether or not a diff is open,
      // so they can be bound from ace's settings menu or mapped from a vimrc. They
      // decline (isAvailable) while there is no diff, which is what leaves their
      // Alt-Up/Alt-Down keys doing what they did before.
      this.aceEditor.commands.addCommands(diffEditorCommands(this));
      this.aceEditor.commands.addCommands(inlineEditorCommands(this));

      // ace-linters implements formatting but binds no key to it, and the
      // command palette lists the focused editor's own ace commands - so this
      // one line is both the keybinding and the palette entry. No-op (with a
      // notice) in an editor no provider registered, e.g. a SAS file: the SAS
      // server advertises no formatting.
      this.aceEditor.commands.addCommand({
        name: "formatDocument",
        description: "Format document (language server)",
        bindKey: { win: "Ctrl-Shift-F", mac: "Command-Shift-F" },
        exec: () => {
          if (!this._lspRegistered || !this._lspProvider) {
            if (window.__ssf) window.__ssf.notify("No language server for this file");
            return;
          }
          try {
            formatWithLsp(this._lspProvider, this.aceEditor);
          } catch (e) {
            console.error("[SS Ext] format failed:", e);
          }
        },
      });
      // Let SAS Studio handle F3/F4 instead of Ace's find-next/find-prev.
      this.aceEditor.commands.bindKey("F3", null);
      this.aceEditor.commands.bindKey("F4", null);

      if (content) {
        this.aceEditor.setValue(content, -1); // -1 -> cursor to start
      }

      this.eventHandlers = { textChanged: [], selectionChanged: [], caretMoved: [] };
      this.setupAceEventBindings();

      // Unsaved-change gutter baseline. Content at construction is the saved
      // state for a file view / the toggle-off editor's text; a code tab is
      // built empty and its file arrives in setText(), which re-baselines.
      // ponytail: a toggle mid-edit baselines the DIRTY text, so the marks
      // (like the undo history) don't survive one.
      this.markSaved();

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
      this._lspRegistering = false;
      this._maybeRegisterLsp();
      // The Lua half of a .sas file, if it has one. Content passed at
      // construction (a text viewer, a toggle conversion) fires no change event
      // this could hang off, so its blocks would stay undiagnosed until the
      // first keystroke - a code editor's own setText does fire one.
      scheduleProcLuaSync(this.aceEditor.session);
    }

    // Eligible when the mode has a language server behind it - SAS
    // (lib/sas-lsp, via ensureLsp) or Lua (lib/emmylua-lsp, via
    // ensureLuaLinters) - and the current line count is within
    // aceConfig.lspMaxLines (0/unset = no limit).
    // Called from the constructor (empty new-program editors) and from setText
    // (real content, which for the code editor arrives after construction).
    _lspEligible() {
      if (this._resolvedMode === "ace/mode/lua") {
        if (getAceConfig().luaLsp === false) return false;
      } else if (this._resolvedMode !== "ace/mode/sas") {
        return false;
      }
      const maxLines = getAceConfig().lspMaxLines;
      return !maxLines || maxLines <= 0 || this.aceEditor.session.getLength() <= maxLines;
    }

    _unregisterLsp() {
      if (!this._lspRegistered) return;
      try {
        // ace-linters' unregisterEditor(editor, cleanupSession) closes the
        // document server-side and takes its session listeners with it.
        if (this._lspProvider) this._lspProvider.unregisterEditor(this.aceEditor, true);
      } catch (e) {
        console.error("[SS Ext] LSP unregister failed:", e);
      }
      this._lspRegistered = false;
      this._lspProvider = null;
    }

    // The mode can change under a live editor - from ace's own settings pane
    // (its Mode dropdown calls session.setMode) or from a Save As under a new
    // extension, via setMode() below - and the mode is what decides WHICH
    // language server this editor belongs to, the two being separate providers
    // over separate workers. So move the editor across.
    // ace-linters' own changeMode handling is not enough: it only re-resolves
    // services INSIDE the shared ServiceManager, and the other server may not be
    // registered there at all yet. Measured before this existed - switching a
    // registered editor from sas to lua left the document on the SAS service,
    // still under its file:///<id>.sas uri, with the Lua server never started
    // and not one lua diagnostic.
    _syncLspToMode() {
      const modeId = this.aceEditor.session.$modeId;
      if (!modeId || modeId === this._resolvedMode) return;
      this._resolvedMode = modeId;
      this._unregisterLsp();
      this._maybeRegisterLsp();
    }

    _maybeRegisterLsp() {
      if (this._lspRegistered || this._lspRegistering) return;
      if (!this._lspEligible()) return;
      const mode = this._resolvedMode;
      const lua = mode === "ace/mode/lua";
      this._lspRegistering = true;
      (lua ? ensureLuaLinters() : ensureLsp()).then((provider) => {
        this._lspRegistering = false;
        if (this._disposed) return;
        // The mode changed while the server was starting: this provider is the
        // wrong one now, and _syncLspToMode's own call bailed on _lspRegistering.
        if (this._resolvedMode !== mode) return this._maybeRegisterLsp();
        if (!provider) return;
        // Re-check: a big setText() may have landed while this promise was in flight.
        if (!this._lspEligible()) return;
        try {
          // registerEditor pushes ace-linters' completer straight into
          // editor.completers - which until this point is the SHARED array
          // ext-language_tools hands every editor, so each registration leaves a
          // stale LSP completer behind for every editor created later (duplicate
          // entries in the popup, one redundant LSP request each). Give this
          // editor its own array first, minus any that already leaked in.
          this.aceEditor.completers = (this.aceEditor.completers || []).filter(
            (c) => c.id !== "lspCompleters",
          );
          // A real path (rather than ace-linters' session-id default) is what
          // gives the Lua server a module name for this document, so a
          // require() of another open .lua tab resolves. Only for the Lua
          // provider: the SAS server has no module concept, and its documents
          // are better left on the ids the rest of this file's LSP code keys on.
          // An editor with no file of its own - a code tab switched to lua mode
          // from the settings pane, a scratch buffer - gets a path under one
          // shared scratch root rather than none: a document under NO workspace
          // root is dropped by the server outright once any root exists
          // (is_workspace_file: no folders means everything, folders means only
          // what matches one), so it silently got no diagnostics at all, and
          // every require() in it was reported "visibility is not `public`",
          // that check needing the requiring file to be a module - which needs a
          // root. Both measured against the real server.
          provider.registerEditor(
            this.aceEditor,
            lua ? { filePath: this._filePath || scratchLuaPath(this.aceEditor) } : undefined,
          );
          this._lspRegistered = true;
          // Which provider to unregister from in dispose() - there are two now.
          this._lspProvider = provider;
          installLspMarkerPatches(provider, this.aceEditor.session);
          // Workaround for ace-linters 2.2.0 with completion.overwriteCompleters:
          // false - the LSP completer is merged in alongside ace's own
          // text/keyword/snippet completers, and the popup sorts by score, so
          // push the default completers' scores down so LSP entries list first.
          // registerEditor above has ALREADY pushed ace-linters' own completer
          // into this array, so it has to be skipped by id - dampening it too
          // (which is what happened before) just shifts everything equally and
          // leaves LSP items, which score 0, below the text completer's words.
          this.aceEditor.completers = (this.aceEditor.completers || []).map((completer) =>
            completer.id === "lspCompleters"
              ? completer
              : Object.assign({}, completer, {
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
          // SAS-only: the meta relabelling and the macro-range fix are about
          // what THAT server sends back (Folder/Keyword for everything); the
          // Lua server kinds its items properly.
          if (!lua) installLspMetaLabels(this.aceEditor);
          // The semanticTokens/full request ace-linters fires on registration
          // races the server's didOpen handling and fails once; kick a refresh
          // after the server's had time to open the document so the initial
          // view is styled without needing an edit/scroll first.
          setTimeout(() => {
            // Gone, or moved to the other server in the meantime (a mode change
            // leaves this provider with no session provider to ask).
            if (this._disposed || this._lspProvider !== provider) return;
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

    setupAceEventBindings() {
      this.aceEditor.session.on("changeMode", () => this._syncLspToMode());
      this.aceEditor.session.on("change", (delta) => {
        this._scheduleDirtyGutter();
        nudgeSasFnCompletions(this.aceEditor);
        scheduleProcLuaSync(this.aceEditor.session);
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
      // The code editor is constructed with empty content and its real text
      // arrives here later (unlike text viewers/toggle conversion, which pass
      // content at construction) - re-check LSP eligibility against the line
      // limit now that real content is in.
      // ponytail: only checked on setText, not on every keystroke - typing
      // growth past the limit isn't monitored; a page reload (or another
      // setText) is needed to pick it up.
      if (this._lspRegistered && !this._lspEligible()) {
        this._unregisterLsp();
        console.log("[SS Ext] LSP: file exceeds lspMaxLines, skipping for this editor");
      } else if (!this._lspRegistered) {
        this._maybeRegisterLsp();
      }
      // Every caller of setText is a load/revert path (AppDMS.js:3857/3896,
      // DMSEditor.js:10252, ...), i.e. the content is the file's again.
      this.markSaved();
    }

    // -- Unsaved-change gutter -------------------------------------------------
    // Re-baseline: the current content IS the saved content. Called on load
    // (constructor/setText) and from every save path - DMSEditor.successfulSave
    // for code tabs, saveTextViewer for text views.
    markSaved() {
      this._savedLines = this.aceEditor.session.doc.getAllLines();
      this._refreshDirtyGutter();
    }

    // Used after a Save As, which can change the file's extension out from under
    // the mode the editor was created with.
    setMode(modeId) {
      const session = this.aceEditor && this.aceEditor.session;
      if (!session || !modeId || session.$modeId === modeId) return;
      session.setMode(modeId);
    }

    _scheduleDirtyGutter() {
      clearTimeout(this._dirtyTimer);
      this._dirtyTimer = setTimeout(() => this._refreshDirtyGutter(), DIRTY_DEBOUNCE_MS);
    }

    // Idempotent, like refreshVimMarkGutter: re-applies the whole decoration set
    // and bails out when nothing changed, since a decoration add/remove signals
    // the gutter to re-render.
    _refreshDirtyGutter() {
      const session = this.aceEditor && this.aceEditor.session;
      if (!session || !this._savedLines) return;
      const lines = session.doc.getAllLines();
      const rows = sameLines(this._savedLines, lines) ? [] : dirtyRows(this._savedLines, lines);
      const previous = this._dirtyRows || [];
      if (JSON.stringify(previous) === JSON.stringify(rows)) return;
      previous.forEach((d) => session.removeGutterDecoration(d.row, d.cls));
      rows.forEach((d) => session.addGutterDecoration(d.row, d.cls));
      this._dirtyRows = rows;
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
      clearTimeout(this._dirtyTimer);
      // An attached diff view holds layers of its own inside this editor, and an
      // inline editor is a whole second editor parked in a line widget.
      if (this._diffView) closeDiff(this);
      if (this._inlineEditor) closeInlineEditor(this);
      this._unregisterLsp(); // must run before aceEditor.destroy() below
      closeProcLuaDoc(this.aceEditor.session); // the Lua half of a .sas session, if any
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
      this.aceEditor.setTheme(prefersDarkTheme() ? cfg.darkTheme : cfg.lightTheme);
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
    newLib: null, // { ace } - our ace library (window.__ssAce), never SAS's
    userSnippets: "", // stashed by toggle()/browse() before the ace lib loads
    _userSnippetsParsed: null, // previously-registered parsed snippets, for unregister
    _textViewers: [], // live { pane, tabHolder, adapter, item, textarea, origSet, origResize, editable, dirty, buttons } entries
    libPath: null, // stashed by loadNewAce() so the palette's editor-toggle command can call toggle(ssExt.libPath)
    aceConfig: null, // seeded by sw.js (tabs.onUpdated) and refreshed by applyAceConfig()
    darkMode: "off", // "off" | "on" | "system", seeded by sw.js - see prefersDarkTheme()
    diffPrefs: null, // { mode, layout } for the diff view, seeded by sw.js, written by its editor commands
    activate,
    deactivate,
    toggle,
    loadNewAce,
    browse,
    commandPalette,
    showVimMappings,
    toggleDiffSaved,
    diffAgainstFile,
    toggleDiffMode,
    applySnippets,
    applyAceConfig,
    AceEditorAdapter, // exposed mainly for test/debug (smoke.js probes config seeding directly)
    _foldNav: { nextFoldStart, prevFoldEnd, enclosingFold }, // pure, covered by test/units.js
    _vimMarks: { vimMarksOf, refreshVimMarkGutter }, // ditto
    _dirtyGutter: { dirtyRowsFromChunks, sameLines }, // ditto
    // `size` is a getter: completionPopupSize is declared further down.
    _popupSizing: { sizePopupToContent, size: () => completionPopupSize },
    _vimrc: { applyVimrcLine, dropShadowingAlias }, // ditto
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
  // Which of the configured theme pair an editor should use.
  //
  // ssExt.darkMode is the extension's own dark-mode setting for SAS Studio's UI
  // (seeded by sw.js from chrome.storage.local.darkMode): "off" | "on" |
  // "system". Forcing it "on" has to drag Ace along, or you get dark app chrome
  // wrapped around a light editor. "off" and "system" both fall through to the
  // OS setting, which is what Ace did before this setting existed - so turning
  // dark mode off never takes an OS-dark editor away from anyone.
  function prefersDarkTheme() {
    if (ssExt.darkMode === "on") return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // The overlays ace builds for us - the command palette prompt, browse_ss, and
  // the stock settings menu - are plain divs on document.body: their inner
  // editors are created with no theme, so they take ace's DEFAULT one, and their
  // containers are `background: white` in ace's own CSS. In dark mode that's a
  // white box full of light text over a dark app. Point the default theme at
  // whichever of our two themes is current (our SAS editors pass a theme
  // explicitly, so they're unaffected) and mark the body so the static sheet
  // below can dress the containers to match. Same for the font size: ace's
  // default is 12px, which is a squint next to a 15px editor - the palette's own
  // input takes the focused editor's size when there is one, but its completion
  // list (and both, when the palette is opened with nothing focused) fall back
  // to the default.
  function syncOverlayDefaults() {
    if (!ssExt.newAceLoaded) return;
    const cfg = getAceConfig();
    const dark = prefersDarkTheme();
    try {
      ace.config.setDefaultValue("editor", "theme", dark ? cfg.darkTheme : cfg.lightTheme);
      ace.config.setDefaultValue("editor", "fontSize", cfg.options.fontSize);
    } catch (e) {
      console.warn("[SS Ext] could not set the ace defaults:", e);
    }
    if (document.body) document.body.classList.toggle("ssExtDark", dark);
  }

  const OVERLAY_DARK_CSS = `
    body.ssExtDark .ace_prompt_container,
    body.ssExtDark .ace_browse_ss_container {
      background: #1f2227;
      color: #c1c1c1;
      box-shadow: 0 2px 8px 0 rgba(0,0,0,0.6);
    }
    body.ssExtDark .ace_browse_ss_hint { color: #8a8f98; }
    body.ssExtDark #ace_settingsmenu,
    body.ssExtDark #kbshortcutmenu {
      background-color: #1f2227;
      color: #c1c1c1;
      box-shadow: -5px 4px 12px rgba(0,0,0,0.6);
      /* The settings panel is a plain <table> of NATIVE controls (ace's own
         .ace_optionsMenuEntry rules match nothing in the DOM it builds). A
         background-color on a <select> is computed but not painted - Chromium
         draws the platform widget - so let the platform draw it dark instead.
         Inherited, so the selects, checkboxes and number inputs all follow. */
      color-scheme: dark;
    }
    body.ssExtDark .ace_optionsMenuEntry:hover { background-color: rgba(255,255,255,0.08); }
    body.ssExtDark .ace_optionsMenuKey { color: #9aa7ff; }
    body.ssExtDark .ace_optionsMenuCommand { color: #6fc3c9; }
    /* Buttons and text inputs are the exception: something in the page paints
       them white, and with the panel's light text that leaves the labels
       invisible. (Checkboxes are left to color-scheme - they read fine.) */
    body.ssExtDark #ace_settingsmenu input:not([type=checkbox]),
    body.ssExtDark #ace_settingsmenu button {
      background: #2b2f36;
      color: #c1c1c1;
      border: 1px solid #4a4f57;
    }
    body.ssExtDark #ace_settingsmenu button:hover { background: #353a42; }
    body.ssExtDark #ace_settingsmenu button[ace_selected_button=true] {
      background: #454b55;
      box-shadow: 1px 0px 2px 0px #1a1d21 inset;
      border-color: #5c636e;
    }
  `;

  function getAceConfig() {
    const cfg = ssExt.aceConfig || {};
    return {
      darkTheme: cfg.darkTheme || "ace/theme/gruvbox",
      lightTheme: cfg.lightTheme || "ace/theme/iplastic",
      options: Object.assign(
        { fontSize: 15, keyboardHandler: "ace/keyboard/vim", useSoftTabs: true, tabSize: 4 },
        cfg.options || {},
      ),
      // Both read by ensureLsp()/_maybeRegisterLsp - lsp was missing here
      // entirely before (ensureLsp's `.lsp === false` check always saw
      // undefined), fixed alongside adding lspMaxLines.
      lsp: typeof cfg.lsp === "boolean" ? cfg.lsp : true,
      lspMaxLines: typeof cfg.lspMaxLines === "number" ? cfg.lspMaxLines : 500,
      // vimrc was missing here too - installSettingsMenuPersistence() posts this
      // object back to chrome.storage.local wholesale, so omitting it silently
      // wiped the saved vimrc on the next in-page settings-menu change.
      vimrc: typeof cfg.vimrc === "string" ? cfg.vimrc : "",
    };
  }

  // Every live AceEditorAdapter on the page: text viewers first, then code tabs.
  function allAdapters() {
    const adapters = ssExt._textViewers.map((e) => e.adapter).filter(Boolean);
    if (typeof appDMS !== "undefined" && appDMS.tabs && appDMS.tabs.getAllTabObjects) {
      appDMS.tabs.getAllTabObjects().forEach((t) => {
        const a = t.editor && t.editor.editor;
        if (a && a._isAceEditorAdapter) adapters.push(a);
      });
    }
    return adapters;
  }

  // Called by sw.js's storage.onChanged listener (aceConfig key) and by the
  // settings-menu persistence hook (installSettingsMenuPersistence, below).
  // Stores the config and live-applies it to every open adapter.
  function applyAceConfig(config) {
    ssExt.aceConfig = config;
    if (!ssExt.newAceLoaded) return; // nothing open yet to apply to

    // sw.js calls this on every dark-mode change too, which is what keeps the
    // prompts/settings panel in step with the app and the editors.
    syncOverlayDefaults();

    const cfg = getAceConfig();
    allAdapters().forEach((a) => {
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
  // The two ace libraries on the page never meet: SAS Studio's own (1.x) build
  // keeps `window.ace` to itself, ours lives on `window.__ssAce` - tools/build_lib.sh
  // builds ace with its module-registry namespace set to ours (see its comment).
  // That is the whole isolation mechanism. Nothing here swaps, pins or restores
  // a global, so the ordering bug class it used to guard against - a lazily
  // loaded keybinding/theme/mode registering itself into whichever library
  // owned `ace` at that moment, which is how vim's :w/:q/:wq/:x once vanished -
  // cannot arise, in either direction: SAS's own lazy loads land in SAS's
  // registry and ours in ours, whatever the timing.
  // Consequently SAS's stock editor still tokenizes against ITS ace, so bumping
  // ACE_VERSION cannot break it and needs no compat shims.

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`[SS Ext] Failed to load ${src}`));
      document.body.appendChild(el);
    });
  }

  // SAS Studio loads its own (1.x) ace purely as a tokenizer - SyntaxColorerAdapter.js
  // imports it for EditSession and nothing else; the stock editor's DOM is
  // EditorView.js's own markup and no SAS file references an .ace_* class. So its
  // stylesheets do nothing for SAS and only interfere with us, two ways:
  //   1. importCssString dedupes by <style> id, so every id SAS registered first
  //      (ace_editor.css, ace-tm, vimMode, ...) silently DROPS our version and the
  //      new editor ends up styled by the old build's css;
  //   2. the new ace inserts its styles at the top of <head>, leaving SAS's later in
  //      the document, where they win every equal-specificity tie.
  // Drop them all before the new build loads: their ids are then free for our own
  // sheets, and if SAS's ace loads afterwards its imports are the ones deduped away.
  function dropOldAceStyles() {
    document.querySelectorAll("style[id]").forEach((el) => {
      if (/^ace[-_]/.test(el.id) || el.id === "vimMode") el.remove();
    });
  }

  // Memoized on the in-flight promise, not just on newAceLoaded: ss-fixes kicks
  // this off at page load outside toggle()/browse()'s _pending chain, so a
  // toggle landing mid-load must await that same load, not start a second one.
  function loadNewAce(libPath) {
    // Callers that already know it pass it; the in-page ones (palette, hotkeys)
    // rely on the seeded value. Never overwrite a known path with nothing - an
    // undefined libPath silently kills every later ensureLsp/worker start, and
    // the page-load load is memoized, so nothing would notice until then.
    libPath = libPath || ssExt.libPath;
    ssExt.libPath = libPath;
    if (ssExt.newAceLoaded) return Promise.resolve();
    if (!ssExt._loading) {
      ssExt._loading = doLoadNewAce(libPath).catch((e) => {
        ssExt._loading = null; // let a later toggle/browse retry
        throw e;
      });
    }
    return ssExt._loading;
  }

  async function doLoadNewAce(libPath) {
    // lib/ace/ is upstream ace 1.43.3 - the custom SAS mode/snippets and
    // the browse_ss extension live under the extension root's src/ace/ instead
    // (see src/ace-patches.js's header comment for the rest of this split).
    const srcAcePath = libPath.replace(/\/lib\/ace\/src-noconflict$/, "/src/ace");

    dropOldAceStyles();
    await loadScript(`${libPath}/ace.js`);
    // ace.js's loader exports the library under the renamed namespace (see the
    // section comment above); window.ace is SAS Studio's and stays that way.
    ace = window.__ssAce;
    if (ace && ace.config) {
      ace.config.set("basePath", libPath);
      // This build resolves "ace/keyboard/<name>" to keyboard-<name>.js, but the
      // bundled files are keybinding-<name>.js - without this override a
      // non-default keyboardHandler (vim, emacs, sublime, vscode - all
      // user-selectable from the options page/settings panel) 404s and silently
      // never loads. Fix the URLs before any editor is created.
      ["vim", "emacs", "sublime", "vscode"].forEach((name) => {
        ace.config.setModuleUrl(`ace/keyboard/${name}`, `${libPath}/keybinding-${name}.js`);
      });
      // ace/mode/sas and ace/snippets/sas aren't in lib/ (see above) - point ace's
      // lazy module loader at src/ace/ instead of the basePath default.
      ace.config.setModuleUrl("ace/mode/sas", `${srcAcePath}/mode-sas.js`);
      ace.config.setModuleUrl("ace/snippets/sas", `${srcAcePath}/snippets-sas.js`);
    }
    // mode-sas.js embeds Ace's own Python/Lua highlight rules for PROC PYTHON/LUA
    // submit;...endsubmit; blocks (require("./python_highlight_rules") etc.), so
    // those modes must already be registered before any editor is created.
    await loadScript(`${libPath}/mode-python.js`);
    await loadScript(`${libPath}/mode-lua.js`);
    // ace/mode/saslog extends ace/mode/sas and ace's define() has no dynamic
    // dependency loading, so both have to be registered up front (both are local
    // extension resources, so this costs no network round trip).
    await loadScript(`${srcAcePath}/mode-sas.js`);
    await loadScript(`${srcAcePath}/mode-saslog.js`);
    // Note: the build's internal require/define are closure-local and it only
    // ever assigns its own namespace object, so window.require/window.define
    // (Dojo's AMD loader) and window.ace (SAS's) are all left alone. Its
    // #ace_editor.css/#ace-tm style elements stay attached permanently from
    // here on - they're harmless since nothing in SAS Studio references .ace_*.

    await loadScript(`${libPath}/ext-language_tools.js`);
    registerOtherEditorsCompleter();
    registerSasContextCompleter();
    registerSasFnCompleter();
    registerProcLuaCompleter();
    await loadScript(`${srcAcePath}/ext-browse_ss.js`);
    // Warm the command-history cache now (fire-and-forget - "SsCmdPaletteHistory",
    // inlined since CMD_HISTORY_KEY is defined later in this closure but not yet
    // in scope here). The adapter's in-editor Alt-Shift-P command opens the
    // palette without awaiting readiness (unlike commandPalette()'s explicit
    // await below), so without this a fresh page's first in-editor palette open
    // would see an empty history and overwrite the persisted MRU list.
    window._browseSsStore.ready("SsCmdPaletteHistory");
    await loadScript(`${libPath}/ext-prompt.js`);
    await loadScript(`${libPath}/ext-statusbar.js`);
    // Only for its line differ (ace/ext/diff/providers/default's computeDiff),
    // which the unsaved-change gutter runs against each editor's saved baseline -
    // none of the diff VIEWS are used.
    await loadScript(`${libPath}/ext-diff.js`);

    // Re-apply the fork's source changes now that everything they patch
    // (ace/autocomplete + ace/snippets from ext-language_tools, ace/ext/modelist
    // from ext-prompt, ace/ext/statusbar from ext-statusbar - none are in ace.js
    // core) has loaded. This MUST run before ext-settings_menu.js below: its
    // bundled ace/ext/options snapshots modelist.modes at load time into the
    // settings-menu Mode dropdown, so the SAS entry has to exist first.
    if (window.__ssExtApplyAcePatches) window.__ssExtApplyAcePatches(ace);

    // Bundles its own copy of ace/ext/options (OptionPanel) - the stock
    // Ctrl-,/showSettingsMenu panel. Eagerly loading it here means ace core's
    // lazy config.loadModule("ace/ext/settings_menu", ...) in the showSettingsMenu
    // command is a no-op (module id already registered), not a second HTTP load.
    await loadScript(`${libPath}/ext-settings_menu.js`);

    // Some themes style .ace_cursor at the same (or higher) specificity as
    // keybinding-vim's ".normal-mode .ace_cursor{border:none;background:...}",
    // and their sheet loads later - github_light_default's "background: none"
    // wipes the vim block cursor out entirely (invisible in normal mode, fine in
    // insert mode and while unfocused, where the 3-class .ace_hidden-cursors rule
    // still wins). ambiance's ".ace-ambiance.normal-mode .ace_cursor-layer{z-index:0}"
    // hides it the same way, behind the marker layer.
    ace.require("ace/lib/dom").importCssString(
      ".normal-mode .ace_cursor{background-color:rgba(255,0,0,0.5)!important}" +
        ".normal-mode .ace_hidden-cursors .ace_cursor{background-color:transparent!important}" +
        ".normal-mode .ace_cursor-layer{z-index:4!important}",
      "ssExtVimCursorFix",
    );

    // Ace's gutter and scroller are `overflow: hidden` over oversized content
    // (.ace_gutter-layer is a literal height:1000000px), so both are real scroll
    // containers with scrollHeight >> clientHeight - ace just never uses that,
    // it translates its layers instead. Anything that scrolls elements by feel
    // rather than by ace's API therefore hits them: SurfingKeys' scroll-target
    // search picks the gutter (and its hasScroll() probe even WRITES scrollTop
    // to test it), which slides the line numbers out of step with the text with
    // no way back short of a reload. `overflow: clip` keeps the clipping and
    // takes the scroll container away, so scrollTop is pinned at 0 for good;
    // ace never reads or writes either element's scrollTop (checked), and the
    // real scrollbars (.ace_scrollbar-*, actual overflow:scroll divs whose
    // scroll event ace listens to) still hand SurfingKeys a working target.
    // Two classes, so no !important is needed to outrank ace's own rules
    // despite importCssString prepending this sheet to <head>.
    ace.require("ace/lib/dom").importCssString(
      ".ace_editor .ace_gutter,.ace_editor .ace_scroller{overflow:clip}",
      "ssExtNoStrayScroll",
    );

    // The completion popup's meta column (library / SASHELP. / CLASS. / program)
    // is flex: 0 0 auto, so it never shrinks - the CAPTION ellipsizes to make
    // room for it. At ace's stock 300px a table-name meta would eat the column
    // names it labels. !important because importCssString prepends to <head>,
    // so this sheet sits ABOVE ace's own and would otherwise lose the tie.
    // Only the editor's own popup: the command palette and browse_ss build their
    // completion list from the same class but size it to their prompt box
    // (`width:100%` inline, max 600/800px), and an !important rule beats an
    // inline style, which left the list narrower than the input above it.
    // The doubled class (rather than !important) is what outranks ace's own
    // 300px rule here: an !important width would also beat the inline width a
    // user drag writes, which is what makes the popup resizable at all.
    ace.require("ace/lib/dom").importCssString(
      ".ace_editor.ace_autocomplete.ace_autocomplete{width:400px}" +
        ".ace_prompt_container .ace_editor.ace_autocomplete," +
        ".ace_browse_ss_container .ace_editor.ace_autocomplete" +
        // resize:vertical - the box's own handle is what sets the width here,
        // which installResizablePopups mirrors onto this list's inline max-width
        // (the 100% below is 100% of the full-screen overlay, since the list is
        // position:absolute and the box isn't positioned).
        "{width:100%!important;resize:vertical}",
      "ssExtCompletionPopup",
    );

    ace.require("ace/lib/dom").importCssString(DIRTY_CSS, "ssExtDirtyGutter");

    ace.require("ace/lib/dom").importCssString(RESIZABLE_CSS, "ssExtResizablePopups");
    installResizablePopups(ace);
    installAutosizeCompletionPopup(ace);

    ace.require("ace/lib/dom").importCssString(OVERLAY_DARK_CSS, "ssExtDarkOverlays");

    ssExt.newLib = { ace: ace };
    ssExt.newAceLoaded = true;

    // One listener for the overlays: the per-adapter matchMedia handlers only
    // cover editors that exist, and a prompt can be opened with none open.
    if (window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", syncOverlayDefaults);
    }
    syncOverlayDefaults();

    installDialogFocusPriorityPatch();
    installSettingsMenuPersistence();
    // Register vim :w/:q/:wq/:x once the new ace (and its vim module) is available.
    await installVimExCommands();
  }

  // -- Completion from the other open editors --------------------------------------
  // Ace's built-in text completer only ever looks at the current session, so a
  // name defined in another open tab never shows up. This one harvests the words
  // of every OTHER live adapter. It goes into ext-language_tools' global
  // completers array (every editor aliases that array by reference), and it has
  // to be registered before any editor exists: _maybeRegisterLsp replaces
  // editor.completers with a mapped copy, which a later addCompleter can't reach.

  // ace/autocomplete/text_completer's own word separator, so both agree on what
  // counts as a word.
  const WORD_SPLIT_RE = /[^a-zA-Z_0-9\$\-\u00C0-\u1FFF\u2C00-\uD7FF\w]+/;
  const sessionWordCache = new WeakMap(); // session -> { words: string[]|null }

  // Splitting every other tab's full text on every keystroke (live autocompletion)
  // gets expensive fast, so cache per session and drop it on edit. One "change"
  // listener per session ever - the entry object stays, only .words is cleared.
  function sessionWords(session) {
    let entry = sessionWordCache.get(session);
    if (!entry) {
      entry = { words: null };
      sessionWordCache.set(session, entry);
      session.on("change", () => (entry.words = null));
    }
    if (!entry.words) entry.words = session.getValue().split(WORD_SPLIT_RE).filter(Boolean);
    return entry.words;
  }

  function registerOtherEditorsCompleter() {
    if (ssExt._otherEditorsCompleterAdded) return;
    ssExt._otherEditorsCompleterAdded = true;
    ace.require("ace/ext/language_tools").addCompleter({
      id: "ssextOtherEditors",
      getCompletions: (editor, session, pos, prefix, callback) => {
        const words = new Set();
        allAdapters().forEach((a) => {
          const other = a.aceEditor && a.aceEditor.session;
          if (!other || other === session) return;
          sessionWords(other).forEach((w) => words.add(w));
        });
        // score 0: below the local text completer's distance-based scores (and
        // far below the LSP's - see _maybeRegisterLsp), which is the right order.
        callback(
          null,
          [...words].map((w) => ({ caption: w, value: w, score: 0, meta: "tab" })),
        );
      },
    });
  }

  // -- SAS context completion: PROC SQL tables + column names ----------------------
  // Two things the SAS language server can't answer, so we answer them from SAS
  // Studio's own library tree (the same source as sas/getLibList):
  //  - PROC SQL data set names. Inside `proc sql;` every position is zone
  //    PROC_STMT_OPT and the server only offers the SELECT statement's option
  //    NAMES: its syntax data types the FROM option as "value", not "dataSet", so
  //    isDataSetType() never fires and no library list is ever requested. Verified
  //    against the language service directly for from/join/create table/insert/update.
  //  - Columns. The server has no column zone at all (getDocumentVariables() is a
  //    `//TODO:` stub), so `keep `, `var `, `select `, `where ` get nothing.
  //
  // ponytail: regexes over the current step, not a SAS parser. Macro-generated
  // names (&tbl) and tables the program hasn't created yet are out of scope - the
  // library tree only knows what already exists on the server.

  // Clause keywords whose operand is a data set, restricted to the ones the
  // language server misses (`set`/`data=` already work, and duplicating them
  // would double every entry).
  const SQL_DATASET_RE = /\b(?:from|join|into|update|table|view)\s+(?:([A-Za-z_]\w*)\.)?[A-Za-z_]*$/i;
  // Same keywords plus the data-step ones, for finding which tables a step reads.
  const TABLE_REF_RE = /\b(from|join|into|update|table|set|merge|data\s*=)\s*/gi;
  // ...but only the SQL ones take an alias: `from a b` aliases a, while the data
  // step's `set a b` / `merge a b` are two data sets.
  const TAKES_ALIAS_RE = /^(?:from|join|into|update|table|view)$/i;
  // Words that can follow a table name but are never an alias or another table.
  const NOT_A_TABLE = new Set(
    ("where group order having on inner left right full outer cross natural join union as select " +
      "from into update table view set merge quit run by and or not when case end do then else if " +
      "output keep drop rename format informat label length retain distinct calculated")
      .split(" "),
  );
  const STEP_LOOKBACK_ROWS = 200; // a single step practically never spans more
  const CONTEXT_SCORE = 1000; // above the LSP's 0, far above the text completers

  // "LIB.TABLE" -> null while the columns are loading, else [{ name, type }].
  const columnsByRef = new Map();

  function refKey(ref) {
    return `${(ref.lib || "WORK").toUpperCase()}.${ref.table.toUpperCase()}`;
  }

  // A run holds the workspace session single-threaded, so a column lookup fired
  // now would just queue behind it (see ss-fixes' minimizeBusyDialog notice).
  function runInProgress() {
    const d = window.__ssfRunDialog;
    return !!(d && d.open && !d._destroyed);
  }

  function warmColumns(refs) {
    if (runInProgress()) return;
    refs.forEach((ref) => {
      const key = refKey(ref);
      if (columnsByRef.has(key)) return;
      columnsByRef.set(key, null);
      resolveColumns(ref)
        .then((cols) => columnsByRef.set(key, cols))
        .catch(() => columnsByRef.set(key, []));
    });
  }

  // "sashelp.class" -> that table's columns, resolved by NAME through the two
  // cached listings so no tree path is ever constructed by hand.
  function resolveColumns(ref) {
    const libName = (ref.lib || "WORK").toUpperCase();
    const tableName = ref.table.toUpperCase();
    return getLibList(null)
      .then((libs) => libs.find((l) => l.name.toUpperCase() === libName))
      .then((lib) => (lib ? getLibList(lib.id) : []))
      .then((tables) => tables.find((t) => t.name.toUpperCase() === tableName))
      .then((table) => (table ? getColumnList(table.id) : []));
  }

  // The whole step around the cursor, plus the text before the cursor within it.
  // It has to reach PAST the cursor: `select | from sashelp.class` names its
  // table after the caret, which is exactly where columns are wanted.
  // Boundaries: back to the last proc/data, forward to the next run;/quit; or
  // next proc/data. An intervening run;/quit; BEFORE the cursor means that step
  // is already over and nothing is in scope.
  function stepAroundCursor(session, pos) {
    const firstRow = Math.max(0, pos.row - STEP_LOOKBACK_ROWS);
    const lastRow = Math.min(session.getLength() - 1, pos.row + STEP_LOOKBACK_ROWS);
    const lines = session.getLines(firstRow, lastRow);
    const text = lines.join("\n");
    const caret =
      lines.slice(0, pos.row - firstRow).reduce((n, l) => n + l.length + 1, 0) + pos.column;
    const before = text.slice(0, caret);

    const boundary = /(?:^|[\s;])(?:proc|data)\b/gi;
    let start = -1;
    let m;
    while ((m = boundary.exec(before))) start = m.index;
    if (start < 0 || /\b(?:run|quit)\s*;/i.test(before.slice(start))) return { before, step: "" };

    const ahead = /\b(?:run|quit)\s*;|(?:^|[\s;])(?:proc|data)\b/i.exec(text.slice(caret));
    const end = ahead ? caret + ahead.index + ahead[0].length : text.length;
    return { before, step: text.slice(start, end) };
  }

  // Table references in a step: `from a.b x`, `join a.b as x`, `set a b`,
  // `merge a b`, `data=a.b`, `from a, b`. Returns [{ lib, table, alias }].
  function tableRefs(stepText) {
    const refs = [];
    const seen = new Set();
    TABLE_REF_RE.lastIndex = 0;
    let m;
    while ((m = TABLE_REF_RE.exec(stepText))) {
      let i = TABLE_REF_RE.lastIndex;
      const takesAlias = TAKES_ALIAS_RE.test(m[1]);
      for (;;) {
        const name = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/.exec(stepText.slice(i));
        if (!name || NOT_A_TABLE.has(name[1].toLowerCase())) break;
        i += name[0].length;
        const alias = takesAlias
          ? /^[ \t]+(?:as[ \t]+)?([A-Za-z_]\w*)/i.exec(stepText.slice(i))
          : null;
        const aliasName = alias && !NOT_A_TABLE.has(alias[1].toLowerCase()) ? alias[1] : null;
        if (aliasName) i += alias[0].length;
        const ref = { lib: name[2] ? name[1] : null, table: name[2] || name[1], alias: aliasName };
        const key = refKey(ref) + "/" + (aliasName || "");
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(ref);
        }
        const separator = /^[ \t]*,[ \t\n]*|^[ \t]+/.exec(stepText.slice(i));
        if (!separator) break;
        i += separator[0].length;
      }
    }
    return refs;
  }

  // Table names run to 32 characters. They used to be capped at 12 here, because
  // ace lets the meta win the flex fight against the caption and the popup was a
  // fixed 400px - installAutosizeCompletionPopup grows it to fit both instead, so
  // the name is shown whole.
  function tableMeta(name) {
    return name.toUpperCase() + ".";
  }

  // Exposed for test/smoke.js (the parsing is checked without a live LSP).
  ssExt._sasContext = {
    tableRefs,
    stepAroundCursor,
    tableMeta,
    columnsByRef,
    relabelLspCompletions,
  };

  function registerSasContextCompleter() {
    if (ssExt._sasContextCompleterAdded) return;
    ssExt._sasContextCompleterAdded = true;
    ace.require("ace/ext/language_tools").addCompleter({
      id: "ssextSasContext",
      getCompletions: (editor, session, pos, prefix, callback) => {
        const results = [];
        try {
          if (session.$modeId === "ace/mode/sas") collectSasContext(session, pos, results);
        } catch (e) {
          console.warn("[SS Ext] SAS context completions failed:", e);
        }
        callback(null, results);
      },
    });
  }

  function collectSasContext(session, pos, results) {
    const { before, step } = stepAroundCursor(session, pos);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const refs = step ? tableRefs(step) : [];
    warmColumns(refs);

    // 1. PROC SQL (and friends): libraries, or one library's tables.
    const dataset = SQL_DATASET_RE.exec(line);
    if (dataset) {
      const libref = dataset[1];
      const lib = libref && resolvedLib(libref);
      if (libref) {
        if (lib) {
          resolvedTables(lib.id).forEach((t) =>
            results.push({
              caption: t.name,
              value: t.name,
              score: CONTEXT_SCORE,
              meta: tableMeta(libref),
            }),
          );
          getLibList(lib.id); // warm, so the next keystroke has it
        } else {
          getLibList(null);
        }
      } else {
        resolvedLibs().forEach((l) =>
          results.push({ caption: l.name, value: l.name, score: CONTEXT_SCORE, meta: "library" }),
        );
        getLibList(null);
      }
    }

    // 2. Columns of every table the step reads. Offered step-wide rather than
    // after an allowlist of clauses (case-when, function arguments, calculated,
    // data-step expressions... an allowlist misses more than it saves), but not
    // at the start of a statement, where a statement keyword is what's wanted.
    if (!refs.length || /(?:^|;)\s*[A-Za-z_]*$/.test(before)) return;
    // A `name.` before the caret scopes the columns to that table - by TABLE
    // name only. SQL aliases are deliberately not resolved here: they're still
    // PARSED, so `from a.b x` doesn't invent a table named x, but `x.` gets no
    // columns rather than a guess.
    const qualifier = /([A-Za-z_]\w*)\.[A-Za-z_]*$/.exec(line);
    const scoped = qualifier
      ? refs.filter((r) => r.table.toUpperCase() === qualifier[1].toUpperCase())
      : refs;
    // A qualifier that names no table in the step (a libref, an alias, a
    // function, ...) is not a column context.
    if (qualifier && !scoped.length) return;

    const seen = new Set();
    scoped.forEach((ref) => {
      (columnsByRef.get(refKey(ref)) || []).forEach((col) => {
        const key = col.name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
          caption: col.name,
          value: col.name,
          score: CONTEXT_SCORE,
          meta: tableMeta(ref.table),
        });
      });
    });
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
  // ./tools/build_lib.sh) server bundle is missing or the worker fails, editors
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

  // How many rows above/below the viewport keep semantic-token markers, so a
  // scroll shows colored text before the re-request for the new range lands.
  const SEMANTIC_TOKEN_MARGIN = 50;
  // Trailing debounce on the token request - ace-linters asks for a fresh
  // (whole-document) token set on every changeScrollTop, i.e. once per scroll
  // frame, and once per edit batch.
  const SEMANTIC_TOKEN_DEBOUNCE = 60;

  // Three perf patches on ace-linters 2.2.0's SessionLanguageProvider, applied
  // once per page against the prototype of the first registered session. All
  // three are about semantic tokens, which the SAS server answers for the WHOLE
  // document (semanticTokens/full) on every edit and every scroll:
  //  1. one ace text marker is created per token, document-wide, even though
  //     only rendered rows can ever show one, and $applyTextMarkers (which runs
  //     on EVERY render) walks the whole set: ~8000 markers created+destroyed
  //     per keystroke on a 1200-line file, 10-60ms of main-thread work per
  //     render. Filtering to the visible range cuts it to a few hundred.
  //  2. session.$textMarkers is an ARRAY indexed by an ever-growing marker id
  //     that removeTextMarker only `delete`s from - the array length grows
  //     unbounded (measured: ~150k per minute of typing) and every render
  //     forEach()es over it, so the editor gets steadily slower the longer the
  //     page has been open. Reset the store once nothing is left in it.
  //  3. debounce the request itself, so a scroll doesn't fire one per frame.
  // AceLanguageClient.for() keeps ONE module-level MockWorker and ONE
  // ServiceManager for the whole page, so the SAS and Lua providers'
  // MessageControllers post to - and listen on - the same channel while each
  // numbers its own callbacks from 1. Every reply reaches both controllers and
  // the default branch fires whatever callbacks[id] it happens to hold, so once
  // the Lua server was up a SAS hover's callback was being consumed by a Lua
  // reply (and vice versa) whenever the two counters overlapped - hover in a
  // .sas file simply stopped answering. Draw both from one counter instead:
  // `this.callbackId++` reads then writes, so the setter can ignore its argument
  // and just advance the shared value.
  let lspCallbackId = 1;
  function shareLspCallbackIds(provider) {
    const mc = provider && provider.$messageController;
    if (!mc || mc._ssextSharedIds) return;
    mc._ssextSharedIds = true;
    Object.defineProperty(mc, "callbackId", {
      get: () => lspCallbackId,
      set: () => {
        lspCallbackId++;
      },
    });
  }

  function installLspMarkerPatches(provider, session) {
    if (ssExt._lspMarkerPatched) return;
    let slp;
    try {
      slp = provider.$getSessionLanguageProvider(session);
    } catch (e) {}
    if (!slp) return;
    const proto = Object.getPrototypeOf(slp);
    if (!proto || !proto.setSemanticTokenMarkers) return;
    ssExt._lspMarkerPatched = true;

    const origSet = proto.setSemanticTokenMarkers;
    proto.setSemanticTokenMarkers = function (tokens) {
      const renderer = this.editor && this.editor.renderer;
      ensureSemanticFallback(this.editor);
      if (tokens && tokens.tokens && renderer) {
        const first = renderer.getFirstVisibleRow() - SEMANTIC_TOKEN_MARGIN;
        const last = renderer.getLastVisibleRow() + SEMANTIC_TOKEN_MARGIN;
        tokens.tokens = tokens.tokens.filter((t) => t.row >= first && t.row <= last);
      }
      // Drop our markers first (the original does this too, harmlessly twice)
      // so the store can be seen empty and reset. Skipped while anything else
      // still holds a marker - ids in flight elsewhere must stay valid.
      const store = this.session.$textMarkers;
      if (store && store.length > 4096) {
        this.clearSemanticTokenMarkers(false);
        // Ours are the one other thing that can be live in here (a PROC LUA
        // block's tokens), and a single live marker blocks the reset - which
        // would put the unbounded growth back for every .sas file that has a
        // block. Drop them for the reset and put them straight back.
        clearProcLuaTokens(this.session);
        let live = false;
        store.forEach(() => (live = true));
        if (!live) {
          this.session.$textMarkers = [];
          this.session.$textMarkerId = 0;
        }
        reapplyProcLuaTokens(this.session);
      }
      return origSet.call(this, tokens);
    };

    const origGet = proto.getSemanticTokens;
    proto.getSemanticTokens = function () {
      clearTimeout(this._ssextTokenTimer);
      this._ssextTokenTimer = setTimeout(() => origGet.call(this), SEMANTIC_TOKEN_DEBOUNCE);
    };

    proto.toAceTokenClassName = function (tokenType) {
      return "ace_" + themedSemanticScope(tokenType).replace(/\./g, " ace_");
    };
  }

  // ace-linters turns an LSP semantic token type into a TextMate-ish scope
  // (method -> "entity.name.function.member") and that scope straight into the
  // marker's class list. Ace THEMES, though, only style a handful of scopes -
  // gruvbox has keyword/comment/variable/constant/string/support/storage and
  // nothing else - so most semantic markers carry a class no rule matches and
  // the text keeps whatever the mode's own tokenizer gave it. That is the whole
  // of "sas.symput() isn't colored like os.date()": both get the identical
  // (invisible) class.name.static / function.member markers, and os only looks
  // highlighted because ace's lua mode hardcodes it as constant.library. So
  // rewrite the leading segments onto scopes themes actually paint; modifiers
  // (".static", ".readonly", ...) ride along untouched.
  const SEMANTIC_SCOPE_ALIASES = {
    "entity.name.type.class": "support.class",
    "entity.name.type.enum": "support.type.enum",
    "entity.name.type.interface": "support.type.interface",
    "entity.name.type": "support.type",
    "entity.name.namespace": "support.class.namespace",
    "entity.name.function.member": "support.function.member",
    "entity.name.function": "support.function",
    "entity.name.variable": "variable",
    "variable.other.enummember": "constant.language.enummember",
    number: "constant.numeric",
    operator: "keyword.operator",
    macro: "constant.language.macro",
    regexp: "string.regexp",
    modifier: "storage.modifier",
    decorator: "support.function.decorator",
  };
  // Longest first, so ".function.member" wins over ".function".
  const SEMANTIC_SCOPE_KEYS = Object.keys(SEMANTIC_SCOPE_ALIASES).sort((a, b) => b.length - a.length);

  function themedSemanticScope(tokenType) {
    const type = String(tokenType || "");
    for (const key of SEMANTIC_SCOPE_KEYS) {
      if (type === key) return SEMANTIC_SCOPE_ALIASES[key];
      if (type.startsWith(key + ".")) return SEMANTIC_SCOPE_ALIASES[key] + type.slice(key.length);
    }
    return type;
  }
  ssExt._semanticScope = themedSemanticScope; // test/units.js

  // ...which only helps for the scopes a theme happens to style, and that varies
  // per theme: ace-chrome has no .ace_support.ace_class rule at all, so `sas` in
  // a .lua file stayed plain-identifier black while `os` looked highlighted only
  // because ace's lua mode hardcodes it as constant.library. So probe the live
  // theme once and give every scope it leaves unpainted a fallback colour taken
  // from the nearest ancestor scope it DOES paint (support.class -> support,
  // variable.other.property -> variable), or from a generic donor when it paints
  // none of them. :where() keeps the rule at zero specificity, so a theme that
  // does style the scope always wins.
  const SEMANTIC_FALLBACK_SCOPES = [
    "support.class",
    "support.class.namespace",
    "support.type",
    "support.type.enum",
    "support.type.interface",
    "support.function",
    "support.function.member",
    "support.function.decorator",
    "storage.type.struct",
    "storage.modifier",
    "variable",
    "variable.parameter",
    "variable.other.property",
    "variable.other.event",
    "constant.language.enummember",
    "constant.language.macro",
    "constant.numeric",
    "keyword.operator",
    "string.regexp",
    "typeParameter",
  ];
  const SEMANTIC_DONOR_SCOPES = ["support.function", "variable", "keyword", "constant"];
  // Tried ahead of the ancestor walk, for the scopes where a different family is
  // the better match: a library table is what `constant.library` is for, and it
  // is what ace's own lua mode paints `os` with - so borrowing it is what puts
  // `sas` and `os` in the same colour instead of merely both in A colour.
  const SEMANTIC_SCOPE_DONORS = {
    "support.class": ["constant.library"],
    "support.class.namespace": ["constant.library"],
  };
  const semanticFallbackThemes = new Set();

  const scopeSelector = (scope) => scope.split(".").map((s) => ".ace_" + s).join("");

  // painted(scope) -> the colour the theme gives that scope, or null. Pure, so
  // test/units.js can drive it with a fake theme.
  function semanticFallbackRules(cls, painted) {
    const donor = SEMANTIC_DONOR_SCOPES.map(painted).find(Boolean);
    const rules = [];
    for (const scope of SEMANTIC_FALLBACK_SCOPES) {
      if (painted(scope)) continue;
      const parts = scope.split(".");
      let color = (SEMANTIC_SCOPE_DONORS[scope] || []).map(painted).find(Boolean) || null;
      for (let n = parts.length - 1; n > 0 && !color; n--) color = painted(parts.slice(0, n).join("."));
      color = color || donor;
      if (color) rules.push(`:where(.${cls}) :where(${scopeSelector(scope)}) { color: ${color}; }`);
    }
    return rules;
  }

  function ensureSemanticFallback(editor) {
    const theme = editor && editor.renderer && editor.renderer.theme;
    const cls = theme && theme.cssClass;
    if (!cls || !document.body || semanticFallbackThemes.has(cls)) return;
    semanticFallbackThemes.add(cls);
    const host = document.createElement("div");
    host.className = "ace_editor " + cls;
    host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden";
    document.body.appendChild(host);
    const colorOf = (scope) => {
      const span = document.createElement("span");
      if (scope) span.className = scopeSelector(scope).replace(/\./g, " ").trim();
      host.appendChild(span);
      const c = window.getComputedStyle(span).color;
      span.remove();
      return c;
    };
    try {
      const base = colorOf("");
      const rules = semanticFallbackRules(cls, (scope) => {
        const c = colorOf(scope);
        return c && c !== base ? c : null;
      });
      if (rules.length) {
        ace.require("ace/lib/dom").importCssString(rules.join("\n"), "ssExtSemanticFallback-" + cls);
      }
    } catch (e) {
      console.warn("[SS Ext] could not build the semantic-token fallback colours:", e);
    } finally {
      host.remove();
    }
  }
  // test/units.js
  ssExt._semanticFallback = { rules: semanticFallbackRules, scopes: SEMANTIC_FALLBACK_SCOPES };

  // -- Library/table names for LSP completion -------------------------------------
  // Answered from SAS Studio's own library tree model - the same source
  // src/ace/ext-browse_ss.js browses. "libraries" lists the libraries,
  // "libraries~SASHELP" one library's members, and the ids come back in that same
  // "~" form, so a library's id round-trips straight back as the next libId.
  // Shape is the server's LibCompleteItem: { id, name, type: DATA|VIEW|LIBRARY }.
  const libListCache = new Map(); // libId ?? "@libs" -> Promise<LibCompleteItem[]>
  // Resolved values of the same keys. Completers run on every keystroke and have
  // to answer synchronously, so they read these and let the promises warm them.
  const libListResolved = new Map();
  ssExt._libListCache = libListCache; // both exposed for test/smoke.js
  ssExt._getLibList = getLibList;

  function getLibList(libId) {
    const key = libId || "@libs";
    if (!libListCache.has(key)) {
      installLibListInvalidation();
      libListCache.set(
        key,
        queryLibList(libId)
          .then((items) => {
            libListResolved.set(key, items);
            return items;
          })
          .catch((e) => {
            console.warn("[SS Ext] library list unavailable:", e);
            libListCache.delete(key); // never cache a failure
            return [];
          }),
      );
    }
    return libListCache.get(key);
  }

  // treeModel is recreated on session reset, so resolve it per call, and let a
  // missing one resolve empty rather than leaving a request unanswered.
  function queryTreeChildren(path) {
    const libs = typeof appDMS !== "undefined" && appDMS.libraries;
    if (!libs || !libs.treeModel) return Promise.resolve([]);
    return Promise.resolve(libs.treeModel.query(path)).then((item) => (item && item.children) || []);
  }

  function queryLibList(libId) {
    return queryTreeChildren(libId || "libraries").then((children) =>
      children
        .filter((c) => c.isLibrary || c.table)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.isLibrary ? "LIBRARY" : c.type === "VIEW" ? "VIEW" : "DATA",
        })),
    );
  }

  // Columns of one table, keyed by the library tree's own id for it (the `id` of
  // the entry getLibList returned, e.g. "libraries~SASHELP~CLASS.DATA"), so the
  // ids round-trip and nothing here builds a path by hand.
  const colListCache = new Map(); // tableId -> Promise<[{ name, type }]>

  function getColumnList(tableId) {
    if (!colListCache.has(tableId)) {
      installLibListInvalidation();
      colListCache.set(
        tableId,
        queryTreeChildren(tableId)
          .then((children) =>
            children
              .filter((c) => c.library === "columns")
              .map((c) => ({ name: c.name, type: c.type })),
          )
          .catch((e) => {
            console.warn("[SS Ext] column list unavailable:", e);
            colListCache.delete(tableId);
            return [];
          }),
      );
    }
    return colListCache.get(tableId);
  }

  // -- Synchronous readers over the caches above (for the completers) -------------

  function resolvedLibs() {
    return libListResolved.get("@libs") || [];
  }

  function resolvedLib(name) {
    const upper = String(name).toUpperCase();
    return resolvedLibs().find((l) => l.name.toUpperCase() === upper);
  }

  function resolvedTables(libId) {
    return libListResolved.get(libId) || [];
  }

  // Uppercased table names of a library, or null when that list isn't loaded -
  // null means "don't know", which the meta relabelling treats differently
  // from "loaded and this name isn't a table".
  function resolvedTableNames(libref) {
    const lib = resolvedLib(libref);
    const tables = lib && libListResolved.get(lib.id);
    return tables ? new Set(tables.map((t) => t.name.toUpperCase())) : null;
  }

  // -- Meta labels on the language server's own completions -----------------------
  // The server tags a library CompletionItemKind.Folder and EVERYTHING else -
  // tables, data set names it parsed out of the program, plain keywords -
  // Keyword (CompletionProvider.getItemKind), and ace-linters turns the kind
  // straight into the popup's right-hand column, so they read "Folder"/"Keyword".
  // Relabel them where we can tell what they are:
  //   Folder                                        -> "library"
  //   Keyword + a known table of the typed libref   -> "SASHELP."
  //   Keyword in a response that also lists libraries -> "program"  (the server
  //     mixes the program's own data set names into that one list, and only that one)
  const KIND_KEYWORD = 14;
  const KIND_FOLDER = 19;

  // Patched in place rather than wrapped in a copy: ace-linters keeps finding
  // this object by id (setServerCapabilities assigns triggerCharacters onto it).
  function installLspMetaLabels(aceEditor) {
    const completer = (aceEditor.completers || []).find((c) => c.id === "lspCompleters");
    if (!completer || completer.__ssextMetaPatched) return;
    completer.__ssextMetaPatched = true;
    const original = completer.getCompletions.bind(completer);
    completer.getCompletions = (ed, session, pos, prefix, callback) => {
      original(ed, session, pos, prefix, (err, results) => {
        try {
          relabelLspCompletions(results, session, pos);
        } catch (e) {
          /* labels/ranges are a nicety - never lose the completions over one */
        }
        callback(err, results);
      });
    };
  }

  function relabelLspCompletions(results, session, pos) {
    if (!results || !results.length) return;
    const kindOf = (r) => r.item && r.item.kind;
    pinMacroRanges(results, session, pos);
    const listsLibraries = results.some((r) => kindOf(r) === KIND_FOLDER);
    const typed = /([A-Za-z_]\w*)\.[A-Za-z_]*$/.exec(session.getLine(pos.row).slice(0, pos.column));
    const tables = typed ? resolvedTableNames(typed[1]) : null;
    results.forEach((r) => {
      const kind = kindOf(r);
      if (kind === KIND_FOLDER) r.meta = "library";
      else if (kind !== KIND_KEYWORD) return;
      else if (tables && tables.has(String(r.caption).toUpperCase())) r.meta = tableMeta(typed[1]);
      else if (listsLibraries) r.meta = "program";
    });
  }

  // The server's own completion prefix keeps a leading % or & (_getPrefix: /[%&]\w*$/),
  // and it labels macro FUNCTIONS with the % included ("%LENGTH") while macro
  // variables come back bare. Ace's prefix stops at the sigil - so accepting
  // "%LENGTH" over a typed "%le" only replaces the "le" and leaves "%%LENGTH".
  // An explicit replace range over the sigil fixes it without widening ace's
  // identifier regexp, which would break the bare-& variables the same way.
  function pinMacroRanges(results, session, pos) {
    const m = /%\w*$/.exec(session.getLine(pos.row).slice(0, pos.column));
    if (!m) return;
    const range = {
      start: { row: pos.row, column: m.index },
      end: { row: pos.row, column: pos.column },
    };
    results.forEach((r) => {
      if (!r.range && String(r.caption || "").startsWith("%")) r.range = range;
    });
  }

  // Libraries change whenever SAS Studio refreshes its library tree: every run end
  // (DMSEditor's submit paths all call libraries.onRefresh()), every library
  // add/delete/rename and the Refresh button (refreshTree()), plus session reset.
  // Hooking both funnels beats a TTL - no stale window, no polling. onRefresh()
  // self-gates on treeViewActive internally, so wrap it rather than relying on it
  // reaching refreshTree.
  function installLibListInvalidation() {
    const libs = typeof appDMS !== "undefined" && appDMS.libraries;
    if (!libs || ssExt._libListInvalidationPatched) return;
    ssExt._libListInvalidationPatched = true;
    ["onRefresh", "refreshTree"].forEach((name) => {
      const original = libs[name];
      if (typeof original !== "function") return;
      libs[name] = function () {
        libListCache.clear();
        libListResolved.clear();
        colListCache.clear();
        columnsByRef.clear();
        return original.apply(this, arguments);
      };
    });
  }

  // Returns a promise of the shared LanguageProvider, or null if LSP is disabled/
  // unavailable. Memoized on ssExt._lspStarting so concurrent AceEditorAdapter
  // constructions share one worker/provider instead of racing to start several;
  // a failure sets ssExt._lspFailed permanently so it's never retried in a loop
  // (a page reload is required to try again, e.g. after building the bundle).
  // ace-linters' own provider.format() is off by one and formats nothing: it
  // builds the whole-document range as row 0 .. `session.getLength()` (the line
  // COUNT, i.e. one PAST the last row) at column `getLine(thatRow).length - 1`,
  // which is -1 since that line doesn't exist. The Lua server answers a plain
  // `null` to a range like that and no edits ever come back. This is the same
  // call it makes - flush the pending deltas, then one format request per range
  // through the session's message controller - with the range it meant. A
  // non-empty selection is formatted instead of the file, as in its version.
  function formatWithLsp(provider, editor) {
    const session = editor.session;
    const slp = provider.$getSessionLanguageProvider(session);
    const selected = (session.getSelection().getAllRanges() || []).filter((r) => !r.isEmpty());
    const lastRow = session.getLength() - 1;
    const ranges = selected.length
      ? selected.map((r) => ({
          start: { line: r.start.row, character: r.start.column },
          end: { line: r.end.row, character: r.end.column },
        }))
      : [
          {
            start: { line: 0, character: 0 },
            end: { line: lastRow, character: session.getLine(lastRow).length },
          },
        ];
    slp.$sendDeltaQueue(() => {
      ranges.forEach((range) =>
        slp.$messageController.format(slp.comboDocumentIdentifier, range, slp.$format, slp.applyEdits),
      );
    });
  }

  // The two servers share this library, and it must be loaded EXACTLY once: its
  // ServiceManager, its MockWorker pair and its classes are all module-level, so
  // a second load replaces window.AceLanguageClient with a fresh copy of all of
  // them and orphans whatever provider was built from the first - separate
  // manager (so serviceName no longer keeps the two apart), separate message
  // channel (so shareLspCallbackIds no longer shares anything) and separate
  // SessionLanguageProvider prototype, which is what installLspMarkerPatches
  // patches ONCE per page: the semantic-token viewport filter then silently
  // applied to one server and not the other (measured - 8000 markers per
  // keystroke on a 800-line file, the exact regression that patch exists for).
  // A `if (!window.AceLanguageClient)` check does not cover it: with a .lua tab
  // restored at page load both servers start at once and both see it unset.
  // ace-linters' UMD wrapper checks the GLOBAL `define` and takes the AMD branch
  // if it looks like one (`typeof define === "function" && define.amd`) - Dojo's
  // own loader satisfies that check, so on this page the module would register
  // itself into Dojo's registry instead of setting
  // window.LanguageClient/window.AceLanguageClient. Hide `define` for the two
  // loads so the UMD wrapper falls through to its plain-global branch instead,
  // same trick as ace.js avoiding window.require/define.
  function loadAceLinters(extRoot) {
    if (ssExt._aceLintersLoading) return ssExt._aceLintersLoading;
    ssExt._aceLintersLoading = (async () => {
      if (window.AceLanguageClient) return;
      const savedDefine = window.define;
      delete window.define;
      try {
        await loadScript(`${extRoot}/lib/ace-linters/language-client.js`);
        await loadScript(`${extRoot}/lib/ace-linters/ace-language-client.js`);
      } finally {
        if (savedDefine) window.define = savedDefine;
      }
    })();
    return ssExt._aceLintersLoading;
  }

  // A side channel onto a language server ace-linters already owns, for the
  // questions it has no API for - the SAS DATA step functions, and everything
  // the PROC LUA blocks need, neither of which belongs to any session
  // ace-linters knows about.
  //
  // Two rules make it safe to share one connection: our request ids are STRINGS
  // (`ssext:<n>`) so they can never collide with ace-linters' numeric ones, and
  // our responses are swallowed rather than forwarded - ace-linters' connection
  // would otherwise see a response to a request it never made.
  //
  // The swallowing is why this owns the worker's `onmessage` shim: that
  // ASSIGNMENT is how vscode-jsonrpc's BrowserMessageReader attaches, so holding
  // the real handler here is the only way to decide, per message, whether it is
  // forwarded at all. `intercept(fn)` is for the callers who need to see (or
  // rewrite, or swallow) messages on their way through: return true to swallow.
  function rawChannel(worker) {
    const pending = new Map();
    const interceptors = [];
    let seq = 0;
    let realOnMessage = null;
    Object.defineProperty(worker, "onmessage", {
      get: () => realOnMessage,
      set: (fn) => {
        realOnMessage = fn;
      },
    });
    worker.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg && typeof msg.id === "string" && msg.id.startsWith("ssext:")) {
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg.error ? null : msg.result);
        }
        return;
      }
      for (const fn of interceptors) {
        try {
          if (fn(e) === true) return;
        } catch (err) {
          console.warn("[SS Ext] LSP message interceptor failed:", (err && err.message) || err);
        }
      }
      if (realOnMessage) realOnMessage.call(worker, e);
    });
    return {
      notify: (method, params) => worker.postMessage({ jsonrpc: "2.0", method, params }),
      request: (method, params) =>
        new Promise((resolve) => {
          const id = `ssext:${++seq}`;
          pending.set(id, resolve);
          worker.postMessage({ jsonrpc: "2.0", id, method, params });
          setTimeout(() => {
            if (pending.delete(id)) resolve(null);
          }, 5000);
        }),
      intercept: (fn) => interceptors.push(fn),
      // Watch a server notification without taking it away from ace-linters,
      // which needs the same stream for the documents it does own.
      onNotification: (method, fn) =>
        interceptors.push((e) => {
          if (e.data && e.data.method === method) fn(e.data.params);
        }),
    };
  }

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
          console.warn("[SS Ext] LSP server bundle not found - run ./tools/build_lib.sh");
          ssExt._lspFailed = true;
          return null;
        }

        await loadAceLinters(extRoot);

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

        // A side channel onto the same server, for questions ace-linters has no
        // API for (sasFunctions() below).
        const raw = rawChannel(worker);
        ssExt._lspRaw = raw;

        // Workaround for ace-linters 2.2.0: its filterByFeature() checks
        // `capabilities.hoverProvider == true`, but the SAS server advertises the
        // LSP-spec-legal object form (e.g. {workDoneProgress: true}), so hover
        // requests are silently never sent. Coerce object-form hoverProvider/
        // documentHighlightProvider to true in the initialize response before
        // ace-linters sees it. The channel above owns the `onmessage` shim this
        // needs (see rawChannel) - an addEventListener wrapper would see the
        // message too late to matter.
        raw.intercept((e) => {
          // sas/getLibList is a request FROM the server: it has no data access of
          // its own and asks the client for the library/table list (we opt in with
          // initializationOptions.supportSASGetLibList below). ace-linters exposes
          // no way to register an inbound request handler, and its connection would
          // answer MethodNotFound as soon as it saw this - first response wins, and
          // ours is async - so answer it here and DON'T forward the message.
          const msg = e.data;
          if (msg && msg.method === "sas/getLibList" && msg.id !== undefined) {
            getLibList(msg.params && msg.params.libId).then((result) => {
              worker.postMessage({ jsonrpc: "2.0", id: msg.id, result });
            });
            return true; // swallowed
          }

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
        });

        const serverData = {
          // UMD builds loaded as classic scripts above (no bundler/dynamic
          // import of a bare specifier) - language-client.js already set
          // window.LanguageClient.
          module: () => Promise.resolve({ LanguageClient: window.LanguageClient }),
          // AceLanguageClient.for() registers into ONE page-wide ServiceManager
          // keyed by this name, defaulting to "server" - so without a name of
          // its own the Lua server registered second simply REPLACED this one
          // and every .sas request found no service for its mode (hover went
          // silent the moment a .lua file was opened).
          serviceName: "sas",
          modes: "sas",
          type: "webworker",
          worker,
          // Without this the server never wires up its lib service and library/
          // table names are simply absent from completion (server.ts's
          // onInitialize -> setLibService). See the sas/getLibList handler above.
          initializationOptions: { supportSASGetLibList: true },
        };

        const provider = window.AceLanguageClient.for(serverData, {
          functionality: { completion: { overwriteCompleters: false }, semanticTokens: true },
        });
        ssExt._lspProvider = provider;
        shareLspCallbackIds(provider);
        installProcLuaHover(provider);
        installProcLuaSignatureHelp(provider);

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

  // -- SAS DATA step functions, for `sas.<name>(...)` --------------------------------
  //
  // PROC LUA makes every DATA step function callable as sas.<name> - in a .lua
  // script it runs as much as in a submit block - which no Lua server can know. Their names and
  // docs are already in the SAS language server, so ask IT at runtime rather than
  // shipping a second, immediately-stale copy: one scratch SAS document parked at
  // a data-step expression, one completion request per popup, and one
  // completionItem/resolve for the doc tooltip of the selected row only.
  // src/lua/sas.lua stays the source for the PACKAGE api (sas.submit, sas.open,
  // ...), which the SAS server knows nothing about; this covers the other half.
  //
  // ponytail: the server filters by prefix itself and answers nothing under two
  // characters, so this is prefix-driven - there is no "list them all", and no
  // cache (a request is ~20 ms against a worker that is already warm).
  const SAS_FN_URI = "file:///ssext/sas-functions.sas";
  const SAS_FN_LINE = " x = "; // row 1 of the scratch document, a data-step expression
  let sasFnVersion = 0;

  function sasFnText(prefix) {
    return `data _null_;\n${SAS_FN_LINE}${prefix}\nrun;\n`;
  }

  async function sasFunctions(prefix) {
    if (!prefix || prefix.length < 2) return [];
    await ensureLsp();
    const raw = ssExt._lspRaw;
    if (!raw) return [];
    const text = sasFnText(prefix);
    if (!sasFnVersion) {
      sasFnVersion = 1;
      raw.notify("textDocument/didOpen", {
        textDocument: { uri: SAS_FN_URI, languageId: "sas", version: 1, text },
      });
    } else {
      raw.notify("textDocument/didChange", {
        textDocument: { uri: SAS_FN_URI, version: ++sasFnVersion },
        contentChanges: [{ text }],
      });
    }
    const res = await raw.request("textDocument/completion", {
      textDocument: { uri: SAS_FN_URI },
      position: { line: 1, character: SAS_FN_LINE.length + prefix.length },
    });
    const items = (res && (res.items || res)) || [];
    return items
      .filter((i) => i.kind === 3) // CompletionItemKind.Function
      .map((i) => ({
        caption: i.label,
        value: i.label,
        meta: "sas fn",
        score: SAS_FN_SCORE,
        __sasFn: true,
      }));
  }

  function sasFunctionDoc(label) {
    const raw = ssExt._lspRaw;
    if (!raw) return Promise.resolve("");
    return raw
      .request("completionItem/resolve", {
        label,
        kind: 3,
        data: { _languageService: "sas", _uri: SAS_FN_URI },
      })
      .then((r) => {
        const doc = r && r.documentation;
        return mdToText((doc && doc.value) || doc || "");
      });
  }

  // The server's answer is markdown with a doc link and a stray <span>; ace's
  // doc tooltip takes plain text (nothing here bundles a markdown converter).
  function mdToText(md) {
    return String(md)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
  }

  // Is the caret completing right after `sas.`?
  function afterSasDot(session, pos, prefix) {
    return session.getLine(pos.row).slice(0, pos.column - prefix.length).endsWith("sas.");
  }

  // The whole `<name>` of a `sas.<name>` the caret is inside, for hover.
  function sasDotWordAt(session, pos) {
    const line = session.getLine(pos.row) || "";
    const before = line.slice(0, pos.column).match(/\bsas\.(\w*)$/);
    if (!before) return null;
    const after = (line.slice(pos.column).match(/^\w*/) || [""])[0];
    const name = before[1] + after;
    return name.length >= 2 ? { name, column: pos.column - before[1].length } : null;
  }

  // emmylua only knows sas.<name> through the index signature in src/lua/sas.lua
  // ("fun(...): any"), so the doc has to come from the same place the completion
  // did. Undefined for anything the SAS server doesn't list as a function, which
  // is what lets the caller fall through to the real Lua hover (sas.submit and
  // the rest of the package API are documented in sas.lua, not by this server).
  // The names src/lua/sas.lua declares itself, so a hover on one of them is left
  // to emmylua. They overlap the DATA step functions (open, close, put, symget,
  // exist, sleep, ...) and the package's version is the one that is actually in
  // scope - sas.put PRINTS, while the SAS PUT() function formats a value. The
  // completer dedupes the same way, by caption.
  let sasLuaNames = null;
  function sasLuaDeclared() {
    if (!sasLuaNames) {
      const extRoot = ssExt.libPath.replace(/\/lib\/ace\/src-noconflict$/, "");
      sasLuaNames = fetch(`${extRoot}/src/lua/sas.lua`)
        .then((r) => r.text())
        .then((text) => new Set((text.match(/^function sas\.\w+/gm) || []).map((m) => m.slice(13))))
        .catch(() => new Set());
    }
    return sasLuaNames;
  }

  async function sasFnHover(session, pos) {
    const word = sasDotWordAt(session, pos);
    if (!word) return undefined;
    if ((await sasLuaDeclared()).has(word.name.toLowerCase())) return undefined;
    const items = await sasFunctions(word.name);
    const match = items.some((i) => i.caption.toLowerCase() === word.name.toLowerCase());
    if (!match) return undefined;
    const text = await sasFunctionDoc(word.name);
    if (!text) return undefined;
    return {
      content: { type: "markdown", text },
      range: {
        start: { row: pos.row, column: word.column },
        end: { row: pos.row, column: word.column + word.name.length },
      },
    };
  }

  // ace gathers completions ONCE when the popup opens and only re-filters on
  // later keystrokes (Autocomplete.updateCompletions' keepPopupPosition branch),
  // so a popup opened at `sas.t` - where the SAS server, which answers nothing
  // under two characters, gave us nothing - can never grow the entries that
  // exist at `sas.to`. Force one fresh gather at exactly two characters; by
  // three the list already has them, so this runs at most once per popup.
  function nudgeSasFnCompletions(editor) {
    // Deferred by a tick because the caller is the session's change event, where
    // the caret has NOT moved yet - and updateCompletions re-derives the prefix
    // from the caret, so a synchronous call re-gathers at the old
    // one-character prefix and changes nothing.
    setTimeout(() => {
      const completer = editor.completer;
      if (!completer || !completer.activated || !completer.completions) return;
      const pos = editor.getCursorPosition();
      const line = (editor.session.getLine(pos.row) || "").slice(0, pos.column);
      if (!/\bsas\.\w\w$/.test(line)) return;
      if ((completer.completions.all || []).some((item) => item.__sasFn)) return;
      try {
        completer.updateCompletions(false);
      } catch (e) {}
    }, 0);
  }

  ssExt._sasFns = { mdToText, afterSasDot, sasDotWordAt }; // test/units.js

  // -- Lua language server (.lua files opened as text) ----------------------------
  //
  // A second server, for Lua, driven entirely by ace-linters: a .lua file is one
  // language end to end, which is exactly ace-linters' case, so it needs no
  // client of its own here. src/lua/sas.lua (opened by the worker) and the
  // sas.<name> completer above are what make the SAS `sas` table known to it.
  const SAS_FN_SCORE = 2000; // above the SAS context completer's 1000

  // Start the emmylua worker - once per page, for ensureLuaLinters() below.
  async function startEmmyLuaWorker() {
    const extRoot = ssExt.libPath.replace(/\/lib\/ace\/src-noconflict$/, "");
    const wasmUrl = `${extRoot}/lib/emmylua-lsp/emmylua_ls.wasm`;
    const resp = await fetch(wasmUrl, { method: "HEAD" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Same blob + importScripts shape as the SAS server above: a worker created
    // straight from a chrome-extension: URL is at the mercy of the page's
    // worker-src, a blob: one isn't.
    // The worker opens the definitions as one extra document right after the
    // initialize, so the server knows the `sas` API with no client-side code.
    const boot =
      `self.__ssExtEmmyLuaWasm=${JSON.stringify(wasmUrl)};` +
      `self.__ssExtEmmyLuaDefs=${JSON.stringify(`${extRoot}/src/lua/sas.lua`)};` +
      `importScripts(${JSON.stringify(`${extRoot}/src/emmylua-worker.js`)})`;
    return new Worker(URL.createObjectURL(new Blob([boot], { type: "text/javascript" })));
  }

  // The .lua-file path: ace-linters, exactly like the SAS server, because a .lua
  // session really is one language end to end. That buys its whole client-side
  // feature set at once - diagnostics (the server pushes
  // textDocument/publishDiagnostics), hover, signature help, document
  // highlights, code actions, semantic tokens, completion+resolve and format -
  // with no UI code here.
  function ensureLuaLinters() {
    if (getAceConfig().luaLsp === false) return Promise.resolve(null);
    if (ssExt._luaLintersStarting) return ssExt._luaLintersStarting;

    ssExt._luaLintersStarting = (async () => {
      try {
        const extRoot = ssExt.libPath.replace(/\/lib\/ace\/src-noconflict$/, "");
        const worker = await startEmmyLuaWorker();
        worker.addEventListener("error", (e) => {
          console.warn("[SS Ext] Lua LSP worker error:", (e && e.message) || e);
        });
        // The same one copy the SAS server uses - see loadAceLinters.
        await loadAceLinters(extRoot);
        // The PROC LUA blocks live in an ace/mode/sas session, which this
        // provider will never be given, so they talk to the same server through
        // the side channel instead - installed BEFORE ace-linters attaches its
        // own onmessage handler, since the channel is what holds it.
        ssExt._luaRaw = rawChannel(worker);
        installProcLuaChannel(ssExt._luaRaw);
        // No capability-coercion shim here (unlike the SAS server, emmylua
        // advertises plain `true` for hoverProvider/documentHighlightProvider)
        // and no inbound-request shim (the worker answers those itself).
        const provider = window.AceLanguageClient.for(
          {
            module: () => Promise.resolve({ LanguageClient: window.LanguageClient }),
            serviceName: "lua", // see the SAS serverData: one shared registry, keyed by name
            modes: "lua",
            type: "webworker",
            worker,
          },
          {
            functionality: { completion: { overwriteCompleters: false }, semanticTokens: true },
          },
        );
        ssExt._luaLintersProvider = provider; // asserted by test/smoke.js
        shareLspCallbackIds(provider);
        installLuaFileHover(provider);
        return provider;
      } catch (e) {
        console.warn(
          "[SS Ext] Lua LSP unavailable (run ./tools/build_lib.sh):",
          (e && e.message) || e,
        );
        return null;
      }
    })();

    return ssExt._luaLintersStarting;
  }

  // The folder path-less lua editors are parked under, so they are inside a
  // workspace root like every other document. The worker turns any document's
  // folder into a root, so opening the first one registers it. Deliberately not
  // under /ssext/ - that prefix is the one rootOf() skips, since the sas.lua defs
  // must not become a requireable module.
  const SCRATCH_LUA_ROOT = "/ssext-scratch";
  const scratchLuaPath = (aceEditor) => `${SCRATCH_LUA_ROOT}/${aceEditor.session.id}.lua`;

  // A .lua file's hover is ace-linters' (emmylua's), which knows sas.<name> only
  // as the index signature - so that one gets the same SAS-function pass first.
  function installLuaFileHover(provider) {
    if (ssExt._luaFileHoverPatched) return;
    ssExt._luaFileHoverPatched = true;
    const original = provider.doHover.bind(provider);
    provider.doHover = (session, position, callback) => {
      const fallback = () => original(session, position, callback);
      sasFnHover(session, position).then(
        (tooltip) => (tooltip ? callback && callback(tooltip) : fallback()),
        fallback,
      );
    };
  }

  let lastCompletionEditor = null;

  // The sas.<name> DATA step functions, offered inside a .lua file. Deliberately
  // NOT a general Lua completer: everything else in that session is ace-linters'
  // (ensureLuaLinters above), and this is the one thing its server cannot know.
  function registerSasFnCompleter() {
    if (ssExt._sasFnCompleterAdded) return;
    ssExt._sasFnCompleterAdded = true;
    ace.require("ace/ext/language_tools").addCompleter({
      id: "ssextSasFns",
      getCompletions: (editor, session, pos, prefix, callback) => {
        // A .lua file, or the Lua inside a PROC LUA block - the `sas` table is
        // in scope in both, and knowable statically in neither.
        if (session.$modeId !== "ace/mode/lua" && !inProcLuaBlock(session, pos)) {
          return callback(null, []);
        }
        if (!afterSasDot(session, pos, prefix)) return callback(null, []);
        lastCompletionEditor = editor; // for getDocTooltip, which gets no editor
        sasFunctions(prefix).then(
          (fns) => callback(null, fns),
          (e) => {
            console.warn("[SS Ext] sas.<name> completion failed:", (e && e.message) || e);
            callback(null, []);
          },
        );
      },
      // Resolve a DATA step function's doc only when its row is selected, the
      // way ace-linters does: fill docText in and re-render the tooltip.
      getDocTooltip: (item) => {
        if (!item || !item.__sasFn || item.docText !== undefined) return;
        item.docText = "";
        sasFunctionDoc(item.caption).then((text) => {
          item.docText = text;
          const completer = lastCompletionEditor && lastCompletionEditor.completer;
          if (text && completer) completer.updateDocTooltip();
        });
        return item;
      },
    });
  }

  // -- PROC LUA submit; ... endsubmit; blocks ------------------------------------
  //
  // The Lua inside a PROC LUA step lives in an ace/mode/sas session, and
  // ace-linters serves a session as ONE language - so that session is the SAS
  // server's and the Lua server can never be given it. Everything here therefore
  // goes over the side channel onto the same emmylua worker (ssExt._luaRaw), and
  // hands its answers to the three surfaces by hand: one extra completer, one
  // hover wrap on the SAS provider, and an annotation merge.
  //
  // The document the server sees is the SAS file with every non-Lua LINE BLANKED
  // OUT. That is the whole of the position handling: an LSP line/character is an
  // ace row/column unchanged, in both directions, so a diagnostic comes back on
  // the row it belongs to and a completion is requested at the caret as it is.
  // The Lua the server sees is exactly the Lua the user wrote.
  const PROC_LUA_SCORE = 2000; // above the SAS context completer's 1000, inside a block
  const PROC_LUA_SYNC_MS = 400;

  // Rows covered by `proc lua ... submit;` / `endsubmit;`, line-granular: the
  // fence lines themselves are SAS, so the Lua body is the rows between them.
  function luaRanges(lines) {
    const ranges = [];
    let state = 0; // 0 = outside, 1 = in a proc lua step, 2 = inside submit
    let start = 0;
    lines.forEach((line, row) => {
      if (state === 2) {
        // `\bsubmit\b` cannot match inside "endsubmit" (no word boundary there),
        // so the two tests below can't confuse the closing fence for an opening one.
        if (/\bendsubmit\b/i.test(line)) {
          ranges.push([start, row - 1]);
          state = 0;
        }
        return;
      }
      if (state === 0 && /\bproc\s+lua\b/i.test(line)) state = 1;
      else if (state === 1 && /\b(run|quit)\s*;/i.test(line)) state = 0;
      if (state === 1 && /\bsubmit\b[^;]*;/i.test(line)) {
        state = 2;
        start = row + 1;
      }
    });
    if (state === 2) ranges.push([start, lines.length - 1]);
    return ranges;
  }

  function inLuaRange(ranges, row) {
    return ranges.some(([from, to]) => row >= from && row <= to);
  }

  function blankNonLua(lines, ranges) {
    return lines.map((line, row) => (inLuaRange(ranges, row) ? line : "")).join("\n");
  }

  function sessionLuaRanges(session) {
    if (!session || session.$modeId !== "ace/mode/sas") return null;
    // The same line limit the language servers themselves honour: this pushes
    // the whole (blanked) file on every edit, which is exactly what that limit
    // is about.
    const maxLines = getAceConfig().lspMaxLines;
    if (maxLines > 0 && session.getLength() > maxLines) return null;
    try {
      const ranges = luaRanges(session.getDocument().getAllLines());
      return ranges.length ? ranges : null;
    } catch (e) {
      return null;
    }
  }

  function inProcLuaBlock(session, pos) {
    const ranges = sessionLuaRanges(session);
    return !!ranges && inLuaRange(ranges, pos.row);
  }

  ssExt._procLua = { luaRanges, inLuaRange, blankNonLua }; // test/units.js

  // One blanked document per SAS session, under the same scratch root the
  // path-less .lua editors use (a document under no workspace root is not a
  // module, and the server drops it once any root exists - see scratchLuaPath).
  const procLuaDocs = new Map(); // ace session id -> { uri, version, text, session }

  function procLuaDoc(session) {
    let doc = procLuaDocs.get(session.id);
    if (!doc) {
      doc = {
        uri: `file://${SCRATCH_LUA_ROOT}/${session.id}-proclua.lua`,
        version: 0,
        text: null,
        session,
      };
      procLuaDocs.set(session.id, doc);
    }
    return doc;
  }

  // Push the session's current Lua to the server, opening the document the first
  // time. Returns the doc, or null when there is no Lua in this session at all -
  // which is what keeps a plain .sas file from ever starting the server (a 12 MB
  // wasm fetch) or opening a document nobody asked for.
  async function syncProcLuaDoc(session) {
    const ranges = sessionLuaRanges(session);
    if (!ranges) {
      // The block was deleted (or the file grew past the limit): close the
      // document and take its diagnostics with it, or they would sit in the
      // gutter of a file that has no Lua in it any more.
      if (procLuaDocs.has(session.id)) {
        closeProcLuaDoc(session);
        setProcLuaAnnotations(session, []);
        dropProcLuaTokens(session);
      }
      return null;
    }
    // Awaiting the provider is what orders this behind ace-linters' initialize:
    // the worker forwards in the order it receives, and that request goes out
    // when the provider is built.
    if (!(await ensureLuaLinters())) return null;
    const raw = ssExt._luaRaw;
    if (!raw) return null;
    const doc = procLuaDoc(session);
    const text = blankNonLua(session.getDocument().getAllLines(), ranges);
    if (doc.text === text) return doc;
    doc.text = text;
    if (doc.version === 0) {
      doc.version = 1;
      raw.notify("textDocument/didOpen", {
        textDocument: { uri: doc.uri, languageId: "lua", version: 1, text },
      });
      hookProcLuaAnnotations(session);
    } else {
      doc.version += 1;
      raw.notify("textDocument/didChange", {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ text }],
      });
    }
    return doc;
  }

  // Debounced, because it runs off the session's change event; the server syncs
  // FULL text, so coalescing costs nothing but the delay.
  function scheduleProcLuaSync(session) {
    if (!session || session.$modeId !== "ace/mode/sas") return;
    // Nothing to do until this file HAS a block - and this runs per keystroke,
    // so it must stay a line scan and nothing more.
    if (!procLuaDocs.has(session.id) && !sessionLuaRanges(session)) return;
    clearTimeout(session.$ssExtProcLuaTimer);
    session.$ssExtProcLuaTimer = setTimeout(() => {
      // Through the token refresh, which syncs first - the tokens have to follow
      // every edit, exactly like the diagnostics the sync itself brings back.
      refreshProcLuaTokens(session).catch((e) =>
        console.warn("[SS Ext] PROC LUA sync failed:", (e && e.message) || e),
      );
    }, PROC_LUA_SYNC_MS);
  }

  function closeProcLuaDoc(session) {
    const doc = session && procLuaDocs.get(session.id);
    if (!doc) return;
    procLuaDocs.delete(session.id);
    clearTimeout(session.$ssExtProcLuaTimer);
    if (doc.version > 0 && ssExt._luaRaw) {
      ssExt._luaRaw.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    }
  }

  // The SAS provider owns session.setAnnotations and replaces the WHOLE set on
  // every validation, so the two servers' diagnostics can only share the gutter
  // if one of them keeps the other's set and re-applies both. This wrapper is
  // that: it remembers what anyone else asked for and always appends ours.
  function hookProcLuaAnnotations(session) {
    if (session.$ssExtAnnotationsHooked) return;
    session.$ssExtAnnotationsHooked = true;
    const original = session.setAnnotations.bind(session);
    session.$ssExtOtherAnnotations = session.getAnnotations() || [];
    session.setAnnotations = (annotations) => {
      session.$ssExtOtherAnnotations = annotations || [];
      original([...session.$ssExtOtherAnnotations, ...(session.$ssExtLuaAnnotations || [])]);
    };
  }

  const LSP_SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "info" };

  function setProcLuaAnnotations(session, annotations) {
    session.$ssExtLuaAnnotations = annotations;
    hookProcLuaAnnotations(session);
    // Through the wrapper, so the SAS server's own set comes back with it.
    session.setAnnotations(session.$ssExtOtherAnnotations || []);
  }

  function installProcLuaChannel(raw) {
    // The semantic-token legend is only ever sent in the initialize result, and
    // this channel is the one thing that sees it whether or not a .lua file is
    // ever opened (ace-linters keeps its copy on a registered session's
    // provider, and a .sas file has none).
    raw.intercept((e) => {
      const caps = e.data && e.data.result && e.data.result.capabilities;
      const legend = caps && caps.semanticTokensProvider && caps.semanticTokensProvider.legend;
      if (legend) procLuaTokenLegend = legend;
    });
    raw.onNotification("textDocument/publishDiagnostics", (params) => {
      const uri = params && params.uri;
      const doc = uri && [...procLuaDocs.values()].find((d) => d.uri === uri);
      if (!doc) return; // a .lua file's own document - ace-linters' business
      setProcLuaAnnotations(
        doc.session,
        (params.diagnostics || []).map((d) => ({
          row: d.range.start.line,
          column: d.range.start.character,
          text: d.message,
          type: LSP_SEVERITY[d.severity] || "info",
        })),
      );
    });
  }

  // LSP CompletionItemKind -> the popup's right-hand column.
  const LUA_ITEM_KINDS = {
    2: "method",
    3: "function",
    5: "field",
    6: "variable",
    7: "class",
    9: "module",
    10: "property",
    12: "value",
    14: "keyword",
    21: "constant",
    22: "struct",
    25: "type param",
  };

  async function procLuaComplete(session, pos) {
    const doc = await syncProcLuaDoc(session);
    if (!doc) return [];
    const res = await ssExt._luaRaw.request("textDocument/completion", {
      textDocument: { uri: doc.uri },
      position: { line: pos.row, character: pos.column },
    });
    const items = (res && (res.items || res)) || [];
    return items.map((item) => ({
      caption: item.label,
      // emmylua returns plain labels for these, but a server may send either -
      // prefer what it asks to insert.
      value: (item.textEdit && item.textEdit.newText) || item.insertText || item.label,
      meta: LUA_ITEM_KINDS[item.kind] || "lua",
      docText: (item.labelDetails && item.labelDetails.detail) || item.detail || "",
      score: PROC_LUA_SCORE,
    }));
  }

  function registerProcLuaCompleter() {
    if (ssExt._procLuaCompleterAdded) return;
    ssExt._procLuaCompleterAdded = true;
    ace.require("ace/ext/language_tools").addCompleter({
      id: "ssextProcLua",
      getCompletions: (editor, session, pos, prefix, callback) => {
        // A .lua file is an ace/mode/lua session and gets the whole ace-linters
        // treatment instead, so this would only duplicate its entries there.
        const ranges = sessionLuaRanges(session);
        if (!ranges || !inLuaRange(ranges, pos.row)) return callback(null, []);
        procLuaComplete(session, pos).then(
          (items) => callback(null, items),
          (e) => {
            console.warn("[SS Ext] PROC LUA completion failed:", (e && e.message) || e);
            callback(null, []);
          },
        );
      },
    });
  }

  // Hover inside a block, in the same order the .lua path uses: the SAS DATA
  // step functions first (emmylua only knows sas.<name> through sas.lua's index
  // signature, so it always has a vaguer answer), then the Lua server, then
  // whatever the SAS server itself makes of the line.
  function installProcLuaHover(provider) {
    if (ssExt._procLuaHoverPatched) return;
    ssExt._procLuaHoverPatched = true;
    const original = provider.doHover.bind(provider);
    provider.doHover = (session, position, callback) => {
      const ranges = sessionLuaRanges(session);
      if (!ranges || !inLuaRange(ranges, position.row)) return original(session, position, callback);
      const fallback = () => original(session, position, callback);
      sasFnHover(session, position)
        .then((tooltip) => tooltip || procLuaHover(session, position))
        .then((tooltip) => (tooltip ? callback && callback(tooltip) : fallback()), fallback);
    };
  }

  // -- Semantic tokens inside a block ---------------------------------------------
  //
  // What paints `sas.sleep` and a required module's members the way `os.date` is
  // painted in a .lua file: `os` only looks highlighted because ace's own lua
  // mode hardcodes it, everything else needs the server. ace-linters does this
  // for the sessions it owns, and this one is the SAS server's, so the tokens are
  // fetched over the side channel and turned into the SAME ace text markers by
  // hand - `session.addTextMarker` is the mixin ace-linters installs on the
  // session prototype at registerEditor, and `toAceTokenClassName` is the
  // (patched, theme-aware - see themedSemanticScope) method on its session
  // provider, so the colours are identical to the .lua tab's by construction.
  //
  // ponytail: no viewport filter (installLspMarkerPatches' reason for existing) -
  // a submit block is a handful of rows, not a 1200-line file. Add one if a block
  // ever gets big enough to feel it.
  let procLuaTokenLegend = null;

  // LSP semantic token type -> the TextMate-ish scope ace themes are written
  // against. Copied from ace-linters' toAceTokenType, which is bundle-internal:
  // matching it is the whole point, since the .lua tab's colours come from it.
  const LUA_TOKEN_SCOPES = {
    class: "entity.name.type.class",
    struct: "storage.type.struct",
    enum: "entity.name.type.enum",
    interface: "entity.name.type.interface",
    namespace: "entity.name.namespace",
    type: "entity.name.type",
    parameter: "variable.parameter",
    variable: "entity.name.variable",
    enumMember: "variable.other.enummember",
    property: "variable.other.property",
    function: "entity.name.function",
    method: "entity.name.function.member",
    event: "variable.other.event",
  };

  // The LSP wire format: five ints per token, the first two delta-encoded
  // (against the previous token's row, and its column when on the same row).
  function decodeSemanticTokens(data, legend) {
    const out = [];
    if (!data || !legend) return out;
    const types = legend.tokenTypes || [];
    const mods = legend.tokenModifiers || [];
    let row = 0;
    let column = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      row += data[i];
      column = data[i] === 0 ? column + data[i + 1] : data[i + 1];
      const name = types[data[i + 3]];
      if (!name) continue;
      const flags = data[i + 4];
      const modifiers = mods.filter((_, bit) => flags & (1 << bit));
      const scope = LUA_TOKEN_SCOPES[name] || name;
      out.push({
        row,
        startColumn: column,
        length: data[i + 2],
        type: modifiers.length ? `${scope}.${modifiers.join(".")}` : scope,
      });
    }
    return out;
  }

  ssExt._procLuaTokens = { decodeSemanticTokens, LUA_TOKEN_SCOPES }; // test/units.js

  function clearProcLuaTokens(session) {
    if (session.removeTextMarker) {
      (session.$ssExtLuaTokenIds || []).forEach((id) => session.removeTextMarker(id));
    }
    session.$ssExtLuaTokenIds = [];
  }

  // The block is gone (or the file is): the markers AND the set they came from,
  // so a later compaction cannot put stale ones back.
  function dropProcLuaTokens(session) {
    clearProcLuaTokens(session);
    session.$ssExtLuaTokens = null;
  }

  // Re-add the last token set as fresh markers, for the one caller that has to
  // take them out from under itself (the marker-store compaction above).
  function reapplyProcLuaTokens(session) {
    const tokens = session.$ssExtLuaTokens;
    if (!tokens || !tokens.length || !session.addTextMarker) return;
    const slp =
      ssExt._lspProvider && ssExt._lspProvider.$getSessionLanguageProvider
        ? ssExt._lspProvider.$getSessionLanguageProvider(session)
        : null;
    if (!slp) return;
    session.$ssExtLuaTokenIds = tokens.map((t) =>
      session.addTextMarker(
        {
          start: { row: t.row, column: t.startColumn },
          end: { row: t.row, column: t.startColumn + t.length },
        },
        slp.toAceTokenClassName(t.type),
      ),
    );
  }

  async function refreshProcLuaTokens(session) {
    const doc = await syncProcLuaDoc(session);
    const slp =
      ssExt._lspProvider && ssExt._lspProvider.$getSessionLanguageProvider
        ? ssExt._lspProvider.$getSessionLanguageProvider(session)
        : null;
    // The marker mixin comes with a registered session; without one there is
    // nothing to draw on (and no SAS server on this file either).
    if (!slp || !session.addTextMarker) return;
    if (!doc) return dropProcLuaTokens(session);
    const res = await ssExt._luaRaw.request("textDocument/semanticTokens/full", {
      textDocument: { uri: doc.uri },
    });
    clearProcLuaTokens(session);
    session.$ssExtLuaTokens = decodeSemanticTokens(res && res.data, procLuaTokenLegend);
    reapplyProcLuaTokens(session);
    // Text markers are drawn into the rendered rows on afterRender, so the ones
    // already on screen need one now.
    if (slp.editor) slp.editor.renderer.$textLayer?.$applyTextMarkers?.();
  }

  // -- Signature help inside a block -----------------------------------------------
  //
  // ace-linters' SignatureTooltip is already attached to this editor (the SAS
  // provider registered it) and calls provider.provideSignatureHelp on every
  // caret move, so the tooltip, its idle timer and its Esc binding are all in
  // place - only the answer has to come from the other server.
  function installProcLuaSignatureHelp(provider) {
    if (ssExt._procLuaSigPatched) return;
    ssExt._procLuaSigPatched = true;
    const original = provider.provideSignatureHelp.bind(provider);
    provider.provideSignatureHelp = (session, position, callback) => {
      const ranges = sessionLuaRanges(session);
      if (!ranges || !inLuaRange(ranges, position.row)) {
        return original(session, position, callback);
      }
      procLuaSignatureHelp(session, position).then(
        (tooltip) => callback && callback(tooltip),
        () => callback && callback(undefined),
      );
    };
  }

  // ace-linters' own fromSignatureHelp, for one server's answer: the active
  // signature's label, with the active parameter bolded (that is the argument
  // highlight) and the documentation under it.
  function signatureTooltip(help) {
    const signature = help && (help.signatures || [])[help.activeSignature || 0];
    if (!signature) return undefined;
    let text = signature.label;
    const param = (signature.parameters || [])[help.activeParameter];
    if (param && typeof param.label === "string") text = text.replace(param.label, `**${param.label}**`);
    const doc = signature.documentation;
    const docText = (doc && (doc.value || doc)) || "";
    if (typeof docText === "string" && docText.trim()) text += "\n\n" + docText;
    return { content: { type: "markdown", text } };
  }

  async function procLuaSignatureHelp(session, pos) {
    const doc = await syncProcLuaDoc(session);
    if (!doc) return undefined;
    const help = await ssExt._luaRaw.request("textDocument/signatureHelp", {
      textDocument: { uri: doc.uri },
      position: { line: pos.row, character: pos.column },
    });
    return signatureTooltip(help);
  }

  ssExt._procLuaSignature = { signatureTooltip }; // test/units.js

  async function procLuaHover(session, pos) {
    const doc = await syncProcLuaDoc(session);
    if (!doc) return undefined;
    const hover = await ssExt._luaRaw.request("textDocument/hover", {
      textDocument: { uri: doc.uri },
      position: { line: pos.row, character: pos.column },
    });
    const contents = hover && hover.contents;
    const text = (contents && (contents.value || contents)) || "";
    if (typeof text !== "string" || !text.trim()) return undefined;
    const range = hover.range || {
      start: { line: pos.row, character: pos.column },
      end: { line: pos.row, character: pos.column },
    };
    return {
      content: { type: "markdown", text },
      range: {
        start: { row: range.start.line, column: range.start.character },
        end: { row: range.end.line, column: range.end.character },
      },
    };
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
    // No code tab to take the class off - a session restored with only text
    // viewers (or none at all) has none, and then this bailed and never patched
    // createCodeEditor, so every tab opened afterwards got the STOCK editor for
    // the rest of the page's life. dojo's sync AMD form has the class either
    // way: AppDMS depends on the module, so it is loaded by the time we run.
    // (Same lookup ss-fixes.js's runFocus patch uses, for the same reason.)
    if (!DMSEditor) {
      try {
        DMSEditor = window.require("webdms/DMSEditor");
      } catch (e) {
        console.warn("[SS Ext] require('webdms/DMSEditor') failed:", e);
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

    // Re-baseline the unsaved-change gutter on save. successfulSave (DMSEditor.js
    // :6978) is the one funnel every save path ends in, and it is always called as
    // this.successfulSave(...), so a prototype wrap holds for tabs that already
    // existed - unlike saveFile, which the toolbar button hitches at construction.
    // Its own "not an autosave" branch is what clears editorContentChanged, so
    // reading the flag afterwards keeps autosaves (which don't write the real file)
    // out without repeating the condition.
    // ponytail: baselines the text as of the RESPONSE, so anything typed during the
    // POST is counted as saved. One round trip wide; a second save fixes it.
    const originalSuccessfulSave = DMSEditor.prototype.successfulSave;
    DMSEditor.prototype.successfulSave = function () {
      const result = originalSuccessfulSave.apply(this, arguments);
      try {
        if (!this.editorContentChanged && this.editor && this.editor.markSaved) {
          this.editor.markSaved();
        }
      } catch (e) {
        console.warn("[SS Ext] could not reset the unsaved-change gutter:", e);
      }
      return result;
    };

    // Save As does NOT end in successfulSave - it ends here (onFileSave calls
    // this on both the 200 and the 499 branch, mirroring saveFile/successfulSave).
    // successfulOnFileSave(err, uri, fileName) is what sets this.name/this.uri,
    // retitles the tab and clears editorContentChanged, so it is the one place
    // that knows the file has a new NAME:
    //   - the mode is resolved once, from the name the editor was created with
    //     (createCodeEditor's aceModeFor(this.name)), so a program saved as .lua
    //     kept SAS highlighting for the rest of the page's life;
    //   - the unsaved-change gutter was never re-baselined by a Save As either,
    //     so the marks stayed on lines that are now saved.
    const originalSuccessfulOnFileSave = DMSEditor.prototype.successfulOnFileSave;
    DMSEditor.prototype.successfulOnFileSave = function (err, uri, fileName) {
      const result = originalSuccessfulOnFileSave.apply(this, arguments);
      try {
        if (err === false && this.editor) {
          if (this.editor.setMode) this.editor.setMode(aceModeFor(fileName || this.name));
          if (!this.editorContentChanged && this.editor.markSaved) this.editor.markSaved();
        }
      } catch (e) {
        console.warn("[SS Ext] could not update the editor after a save-as:", e);
      }
      return result;
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
      item && item.uri,
    );
    // Always editable (like a normal editor); the dirty state drives the tab
    // marker and Save button, and Ctrl/Cmd+S / vim :w save. That includes the
    // ss-fixes log tab, which has no file behind it: editing it is harmless (F5
    // puts the log back), and saveTextViewer's no-uri guard turns a stray Ctrl+S
    // into one error message.
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
    // Going clean means a save landed (or fresh content was mirrored in): the
    // unsaved-change gutter's baseline is the current text again.
    if (!dirty && entry.adapter && entry.adapter.markSaved) entry.adapter.markSaved();
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

  // Loaded with our own loadScript (not config.loadModule) and awaited, so the
  // module is registered before loadNewAce returns and the defineEx calls below
  // definitely run. keybinding-vim.js registers itself through the GLOBAL `ace`
  // (src-noconflict build) - that used to land in SAS's old library whenever
  // loadNewAce ran with the toggle inactive (browse/palette before activation),
  // which left vim itself working but :w/:q/:wq/:x and the vimrc silently gone.
  // The "Show vim key mappings" action (SSF_TOOLS -> command palette / a
  // rebindable hotkey): lists EVERY mapping - vim.js's ~190 built-ins plus the
  // user's. ace's vim has no listing of its own; the one thing it does expose is
  // the keymap array itself (exports.handler.defaultKeymap), which is the complete
  // set, with Vim.map's unshifted user entries on top. Far too long for vim's
  // notification box, so it opens in the same ace prompt the command palette uses -
  // the filter input searches both the keys and what they do ("dd", "delete",
  // "addCursorAbove").
  //
  // It is deliberately NOT wired to a `:map` ex-command: the ex dialog's close()
  // ends with editor.focus(), so a prompt opened from there loses the focus again
  // (deferring the open past the close didn't hold either).
  const VIM_MODE_CHAR = { normal: "n", insert: "i", visual: "v", operatorPending: "o" };

  // What an entry does, in vim.js's own terms: a keyToKey mapping's right-hand
  // side, otherwise the operator/motion/action it dispatches (plus the ace command
  // name for the `aceCommand` action, which is the only interesting actionArg).
  function vimMappingTarget(m) {
    if (m.toKeys) return m.toKeys;
    const name = [m.operator, m.motion, m.action].filter(Boolean).join(" ") || m.type;
    const aceCommand = m.actionArgs && m.actionArgs.name;
    return aceCommand ? `${name} ${aceCommand}` : name;
  }

  function vimMappingEntries() {
    // ponytail: the array ace exported when keybinding-vim.js loaded. Vim.mapclear()
    // replaces the module's own reference with a fresh array, so after a :mapclear
    // this lists stale entries - reload to resync.
    const vim = ssExt.newLib.ace.require("ace/keyboard/vim");
    const keymap = (vim && vim.handler && vim.handler.defaultKeymap) || [];
    return keymap.map((m) => ({
      value: `${String(m.keys).padEnd(14)}${vimMappingTarget(m)}`,
      // No context means the mapping applies in every mode.
      meta: VIM_MODE_CHAR[m.context] || "all",
    }));
  }

  async function doShowVimMappings() {
    if (!ssExt.libPath) {
      console.error("[SS Ext] showVimMappings: no libPath known yet - can't load the Ace library");
      return;
    }
    // loadNewAce awaits installVimExCommands, which is what loads keybinding-vim.js.
    await loadNewAce(ssExt.libPath);
    openVimMappingsPrompt(focusedAceEditor(), vimMappingEntries());
  }

  // Serialized through the same _pending chain as toggle()/browse()/commandPalette().
  function showVimMappings() {
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(doShowVimMappings, doShowVimMappings);
    return ssExt._pending;
  }

  function openVimMappingsPrompt(editor, entries) {
    const FilteredList = ssExt.newLib.ace.require("ace/autocomplete").FilteredList;
    ssExt.newLib.ace.require("ace/ext/prompt").prompt(editor || null, "", {
      name: "vimMappings",
      selection: [0, Number.MAX_VALUE],
      onAccept: function () {}, // a listing: picking a row just closes the prompt
      getPrefix: function (cmdLine) {
        return cmdLine.getValue().substring(0, cmdLine.getCursorPosition().column);
      },
      getCompletions: function (cmdLine) {
        // Clone like prompt.commands does - FilteredList mutates its input.
        const cloned = JSON.parse(JSON.stringify(entries));
        const filtered = new FilteredList(cloned).filterCompletions(cloned, this.getPrefix(cmdLine));
        return filtered.length > 0 ? filtered : [{ value: "No matching mappings", error: 1 }];
      },
    });
  }

  // -- Vim fold navigation ---------------------------------------------------------
  // ace's vim ships zc/zo/za/zf/zd (fold toggling) but nothing to move BETWEEN folds,
  // and ace has no command for it either - the fold widgets the gutter renders from
  // are the only thing to go on. These three walk them; installVimFoldMotions() maps
  // them onto vim's zj / zk / [z / ]z.
  //
  // ponytail: a linear scan per keypress, uncached - session.getFoldWidget is bound
  // straight to the fold mode, so every row re-runs its regexes. Memoize per session
  // if it ever shows up on a huge log.

  // zj: the start row of the next fold below `row`, or null.
  function nextFoldStart(session, row) {
    for (let r = row + 1; r < session.getLength(); r++) {
      if (session.getFoldWidget(r) === "start") return r;
    }
    return null;
  }

  // zk: the end row of the previous fold above `row`, or null. Reads the "end"
  // widgets, i.e. needs foldStyle "markbeginend" (DEFAULT_ACE_CONFIG's) - with ace's
  // own "markbegin" default no row ever reports one and zk finds nothing.
  function prevFoldEnd(session, row) {
    for (let r = row - 1; r >= 0; r--) {
      if (session.getFoldWidget(r) === "end") return r;
    }
    return null;
  }

  // [z / ]z: the innermost fold range containing `row`, or null. Walks up to the
  // nearest "start" whose range still reaches `row`; sibling folds that opened and
  // closed on the way up are skipped.
  function enclosingFold(session, row) {
    for (let r = row; r >= 0; r--) {
      if (session.getFoldWidget(r) !== "start") continue;
      const range = session.getFoldWidgetRange(r);
      if (range && range.end.row >= row) return range;
    }
    return null;
  }

  function installVimFoldMotions(vim) {
    const Vim = vim.Vim;
    if (Vim.$ssExtFoldMotions) return;
    Vim.$ssExtFoldMotions = true;
    const Pos = vim.CodeMirror.Pos;
    // No `context`, so they work in visual and operator-pending mode too (d]z).
    // mapCommand unshifts onto defaultKeymap, so [z/]z win over the generic
    // `[<character>`/`]<character>` moveToSymbol motions already in there.
    const define = (name, keys, pickRow) => {
      Vim.defineMotion(name, (cm, head) => {
        const session = cm.ace && cm.ace.session;
        if (!session || !session.getFoldWidget) return head;
        const row = pickRow(session, head.line);
        return row == null ? head : new Pos(row, 0);
      });
      Vim.mapCommand(keys, "motion", name, {});
    };
    define("ssExtNextFoldStart", "zj", nextFoldStart);
    define("ssExtPrevFoldEnd", "zk", prevFoldEnd);
    define("ssExtFoldStart", "[z", (s, r) => {
      const fold = enclosingFold(s, r);
      return fold && fold.start.row;
    });
    define("ssExtFoldEnd", "]z", (s, r) => {
      const fold = enclosingFold(s, r);
      return fold && fold.end.row;
    });
  }

  // -- Unsaved-change gutter ---------------------------------------------------------
  // A bar in the gutter on every line that differs from the last saved content,
  // diffed with ace's own ext/diff line differ (the Myers implementation its stock
  // diff view uses). Rows are marked through session.addGutterDecoration, the way
  // the vim mark gutter does, NOT with that extension's own MinimalGutterDiffDecorator:
  // that one renders into recycled gutter cells and its class removal is a no-op
  // (classList.remove(Object.values(...)) passes an ARRAY, so it removes the token
  // "mini-diff-added,mini-diff-deleted" and never the real classes), which smears
  // stale marks over every row as you scroll.
  //
  // ponytail: gutter only, no scrollbar overview - that means replacing
  // renderer.$scrollDecorator with ScrollDiffDecorator, and ace-patches.js already
  // has its own stake in the decorator layer. Add it if the gutter isn't enough.
  const DIRTY_CLASS = "ssExtDirty";
  const DIRTY_DEL_CLASS = "ssExtDirtyDel";
  const DIRTY_DEBOUNCE_MS = 250;

  // Both fixed colours, readable on light and dark editor themes alike. The gutter
  // cell is position:absolute (see vimMarkStyles), so these ride in its left edge;
  // ::before, since the vim mark letters own ::after.
  const DIRTY_CSS =
    `.${DIRTY_CLASS}::before,.${DIRTY_DEL_CLASS}::before` +
    `{content:"";position:absolute;left:0;width:2px;background:#4a9eff}` +
    `.${DIRTY_CLASS}::before{top:0;bottom:0}` +
    // A deleted block has no line left to mark, so it gets half a bar (at the top
    // of the row that closed the gap) in a different colour instead.
    `.${DIRTY_DEL_CLASS}::before{top:0;height:45%;background:#e05252}`;

  function sameLines(a, b) {
    return a.length === b.length && a.every((line, i) => line === b[i]);
  }

  // computeDiff's chunks are {origStart, origEnd, editStart, editEnd} with EXCLUSIVE
  // end rows, edit* being the new (current) side. editEnd == editStart is a pure
  // deletion: nothing of it is left to mark, so the row that closed the gap gets the
  // deleted bar - clamped, since a deletion at the end of the file leaves editStart
  // past the last row.
  function dirtyRowsFromChunks(chunks, lineCount) {
    const rows = [];
    (chunks || []).forEach((c) => {
      if (c.editEnd > c.editStart) {
        for (let row = c.editStart; row < c.editEnd; row++) rows.push({ row, cls: DIRTY_CLASS });
      } else {
        rows.push({ row: Math.min(c.editStart, Math.max(0, lineCount - 1)), cls: DIRTY_DEL_CLASS });
      }
    });
    return rows;
  }

  function dirtyRows(savedLines, lines) {
    try {
      const computeDiff = ace.require("ace/ext/diff/providers/default").computeDiff;
      // maxComputationTimeMs: the differ gives up and reports one whole-file chunk
      // rather than blocking the keystroke it runs behind.
      return dirtyRowsFromChunks(
        computeDiff(savedLines, lines, { maxComputationTimeMs: 100 }),
        lines.length,
      );
    } catch (e) {
      console.warn("[SS Ext] unsaved-change gutter unavailable:", e);
      return [];
    }
  }

  // -- Vim marks -------------------------------------------------------------------
  // ace's vim keeps marks on the CodeMirror adapter (editor.state.cm.state.vim.marks,
  // name -> Marker) and gives them no UI at all: no :marks listing, nothing in the
  // gutter. Both are added here off vim's own data - vim.js already shifts those
  // Markers on every edit, so nothing has to track rows itself.
  //
  // The gutter is via session.addGutterDecoration (one class per mark letter, its CSS
  // ::after prints the letter); the scrollbar overview is deliberately left alone -
  // ace's decorator layer draws fixed-width bars with no room for a label.
  const VIM_MARK_CLASS = "ssExtVimMark";

  // Only the letter marks - '/</>/[/] etc. are vim's own bookkeeping, and real vim
  // doesn't gutter those either. Class names go by char code: HTML class selectors
  // are case-sensitive, so `a` and `A` must not collide.
  function vimMarksOf(editor) {
    const cm = editor && editor.state && editor.state.cm;
    const marks = (cm && cm.state && cm.state.vim && cm.state.vim.marks) || {};
    return Object.keys(marks)
      .filter((name) => /^[a-zA-Z]$/.test(name))
      .sort()
      .map((name) => {
        const pos = marks[name].find && marks[name].find();
        return pos && { name, row: pos.line, column: pos.ch };
      })
      .filter(Boolean);
  }

  // Idempotent: re-applies the whole decoration set, so it can be called from any
  // event. Bails out unchanged, since it runs on every keystroke (each add/remove
  // signals the gutter to re-render).
  function refreshVimMarkGutter(editor) {
    const session = editor.session;
    if (!session) return;
    const previous = editor.$ssExtMarkRows || [];
    const current = vimMarksOf(editor).map((m) => ({
      row: m.row,
      cls: `${VIM_MARK_CLASS}-${m.name.charCodeAt(0)}`,
    }));
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    previous.forEach((d) => session.removeGutterDecoration(d.row, d.cls));
    current.forEach((d) => session.addGutterDecoration(d.row, d.cls));
    editor.$ssExtMarkRows = current;
  }

  function vimMarkStyles() {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return (
      (letters + letters.toUpperCase())
        .split("")
        .map((c) => `.${VIM_MARK_CLASS}-${c.charCodeAt(0)}::after{content:"${c}"}`)
        .join("\n") +
      // The gutter cell is position:absolute, so this rides in its left padding,
      // left of the line number and clear of the fold widget on the right.
      `\n[class*="${VIM_MARK_CLASS}-"]::after{position:absolute;left:2px;opacity:.65;font-size:.85em}`
    );
  }

  // Hooks the vim handler's own attach/detach rather than our adapter: it is called
  // for every editor that gets the vim keyboard handler, including a switch made at
  // runtime from ace's settings menu, and detach is where cm (and its marks) dies.
  function installVimMarkGutter(vim, ace) {
    const handler = vim.handler;
    if (handler.$ssExtMarkGutter) return;
    handler.$ssExtMarkGutter = true;
    ace.require("ace/lib/dom").importCssString(vimMarkStyles(), "ssExtVimMarks");
    const origAttach = handler.attach;
    const origDetach = handler.detach;
    handler.attach = function (editor) {
      origAttach.call(this, editor);
      const refresh = () => refreshVimMarkGutter(editor);
      editor.$ssExtMarkRefresh = refresh;
      // vim.js signals vim-command-done from clearInputState, i.e. BEFORE the command
      // it announces has run - refreshing inline would list `ma` one command late.
      editor.state.cm.on("vim-command-done", () => setTimeout(refresh, 0));
      editor.on("change", refresh); // an edit shifts the marks below it
      refresh();
    };
    handler.detach = function (editor) {
      const refresh = editor.$ssExtMarkRefresh;
      if (refresh) editor.off("change", refresh); // the cm listener dies with cm.destroy()
      editor.$ssExtMarkRefresh = null;
      (editor.$ssExtMarkRows || []).forEach((d) => editor.session.removeGutterDecoration(d.row, d.cls));
      editor.$ssExtMarkRows = [];
      origDetach.call(this, editor);
    };
  }

  // :marks - vim's own listing, which ace's vim never implemented, shown the same way
  // its :registers is (a bottom notification box). Short enough not to need a prompt.
  function showVimMarks(cm) {
    const editor = cm.ace;
    const marks = vimMarksOf(editor);
    const text = marks.length
      ? "mark  line   col  text\n" +
        marks
          .map(
            (m) =>
              ` ${m.name}   ${String(m.row + 1).padStart(5)} ${String(m.column).padStart(5)}  ` +
              editor.session.getLine(m.row).trim().slice(0, 60)
          )
          .join("\n")
      : "No marks set";
    const box = document.createElement("div");
    box.style.whiteSpace = "pre";
    box.style.fontFamily = "monospace";
    box.textContent = text;
    if (cm.openNotification) cm.openNotification(box, { bottom: true, duration: 8000 });
  }

  async function installVimExCommands() {
    if (ssExt._vimExInstalled) return;
    ssExt._vimExInstalled = true; // guard now so concurrent loads don't double-register
    try {
      await loadScript(`${ssExt.libPath}/keybinding-vim.js`);
      const vim = ssExt.newLib.ace.require("ace/keyboard/vim");
      const Vim = vim && vim.Vim;
      if (!Vim || !Vim.defineEx) throw new Error("ace/keyboard/vim did not register");
      const saveAndClose = (cm) => {
        const ctx = resolveAceContext(cm.ace);
        vimSave(ctx);
        vimClose(ctx);
      };
      Vim.defineEx("write", "w", (cm, params) => {
        const path = params && params.argString && params.argString.trim();
        if (path) {
          if (window.__ssf && window.__ssf.saveFocusedFileAtPath) window.__ssf.saveFocusedFileAtPath(path);
          else console.warn("[SS Ext] :w <path> unavailable (ss-fixes not loaded)");
          return;
        }
        vimSave(resolveAceContext(cm.ace));
      });
      Vim.defineEx("quit", "q", (cm) => vimClose(resolveAceContext(cm.ace)));
      Vim.defineEx("wq", "wq", saveAndClose);
      Vim.defineEx("xit", "x", (cm, params) => {
        // Vim exits visual mode (collapsing the Ace selection) before the ex
        // handler runs, but keeps the range as params.line/lineEnd - re-select it
        // so runCurrentProgram submits the selection instead of the whole file.
        if (params && params.line !== undefined && cm.ace) {
          const end = params.lineEnd !== undefined ? params.lineEnd : params.line;
          const sel = cm.ace.selection;
          sel.moveTo(params.line, 0);
          sel.selectTo(end, cm.ace.session.getLine(end).length);
        }
        if (window.__ssf && window.__ssf.run) window.__ssf.run("runCurrentProgram");
      });
      Vim.defineEx("marks", "marks", showVimMarks);

      // Own catch: a fold-motion failure must not take the ex-commands down with it.
      try {
        installVimFoldMotions(vim);
      } catch (e) {
        console.warn("[SS Ext] vim fold motions zj/zk/[z/]z not installed:", e);
      }
      // Same: the gutter markers are cosmetic, :marks and the rest must survive them.
      try {
        installVimMarkGutter(vim, ssExt.newLib.ace);
      } catch (e) {
        console.warn("[SS Ext] vim mark gutter markers not installed:", e);
      }

      const vimrcText = (ssExt.aceConfig && ssExt.aceConfig.vimrc) || "";
      const keymap = (vim.handler && vim.handler.defaultKeymap) || null;
      vimrcText.split("\n").forEach((line) => applyVimrcLine(Vim, line, keymap));
      ssExt._vimrcApplied = (ssExt._vimrcApplied || 0) + 1;
      ssExt._vimrcLastText = vimrcText;
    } catch (e) {
      ssExt._vimExInstalled = false;
      console.warn("[SS Ext] vim :w/:q/:wq/:x not installed:", e);
    }
  }

  function restoreTextViewers() {
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

  // Text viewers that already exist when the toggle goes on: the createFileView
  // wrapper only converts viewers created while active, and tabs restored from the
  // last session (SASStudioTabs.loadPersistedTabs, run during app startup) are
  // built long before injection - so a restored .log/.txt tab kept its plain
  // SimpleTextarea for the rest of the page's life. Only createFileView ever sets
  // `tabHolder` on a tab (AppDMS.js:4291), so that is the whole "is this a text
  // viewer" test.
  function swapTextViewersToAce() {
    let swapped = 0;
    const tabs = appDMS.getCurrentPerspectiveSASStudioTabs();
    (tabs?.getAllTabObjects?.() || []).forEach((item) => {
      const tabHolder = item.tab && item.tab.tabHolder;
      if (!tabHolder || !tabHolder.textContainer) return;
      if (ssExt._textViewers.some((e) => e.tabHolder === tabHolder)) return;
      try {
        convertTextViewerToAce(item, tabHolder);
        swapped++;
      } catch (e) {
        console.error("[SS Ext] Failed to convert existing text viewer to Ace:", e);
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
    ssExt.active = true;
    installPatches();

    const swapped = swapTabsToAce();
    const viewers = swapTextViewersToAce();
    console.log(`[SS Ext] activated Ace editor, ${swapped} tab(s) swapped, ${viewers} text viewer(s) swapped`);
    return { active: true };
  }

  async function deactivate() {
    if (!ssExt.active) return { active: false };

    ssExt.active = false;

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

  /** The adapter owning the focused Ace editor, if any (see focusedAceEditor). */
  function focusedAdapter() {
    const editor = focusedAceEditor();
    return (editor && allAdapters().find((a) => a.aceEditor === editor)) || null;
  }

  // -- Inline editor ---------------------------------------------------------------
  // Ported from ace's kitchen-sink demo (demo/kitchen-sink/inline_editor.js - demo
  // code, no ext ships it): a second editor embedded as a LINE WIDGET at the cursor
  // row, on a clone of the same session, so it is another view of the same document
  // (edits and undo are shared) with its own scroll, folds and caret - handy for
  // keeping a macro definition in sight while editing its call site.
  // Changes from the demo, each asked for: the widget is resizable (the demo's
  // height is a fixed 10 rows), and it is an editor COMMAND with no F3 binding -
  // F3 is SAS Studio's Run Program, which the adapter unbinds from ace anyway.
  const INLINE_EDITOR_ROWS = 10;

  // ext-split's $cloneSession, which is an instance method there (so not reachable
  // off the prototype) and the only thing that file would be loaded for: same
  // Document, own everything else.
  function cloneSession(session) {
    const EditSession = ace.require("ace/edit_session").EditSession;
    const clone = new EditSession(session.getDocument(), session.getMode());
    clone.setUndoManager(session.getUndoManager()); // shared, so undo spans both
    clone.setTabSize(session.getTabSize());
    clone.setUseSoftTabs(session.getUseSoftTabs());
    clone.setOverwrite(session.getOverwrite());
    clone.setBreakpoints(session.getBreakpoints());
    clone.setUseWrapMode(session.getUseWrapMode());
    clone.setUseWorker(session.getUseWorker());
    clone.setWrapLimitRange(session.$wrapLimitRange.min, session.$wrapLimitRange.max);
    clone.$foldData = session.$cloneFoldData();
    return clone;
  }

  function closeInlineEditor(adapter) {
    const entry = adapter._inlineEditor;
    if (!entry) return;
    adapter._inlineEditor = null;
    if (entry.observer) entry.observer.disconnect();
    // removeLineWidget destroys w.editor for us, and takes the element out.
    try {
      adapter.aceEditor.session.widgetManager.removeLineWidget(entry.widget);
    } catch (e) {
      console.error("[SS Ext] inline editor close failed:", e);
    }
    adapter.aceEditor.focus();
  }

  function openInlineEditor(adapter) {
    const editor = adapter.aceEditor;
    const session = editor.session;
    const LineWidgets = ace.require("ace/line_widgets").LineWidgets;
    const Editor = ace.require("ace/editor").Editor;
    const Renderer = ace.require("ace/virtual_renderer").VirtualRenderer;

    if (!session.widgetManager) {
      session.widgetManager = new LineWidgets(session);
      session.widgetManager.attach(editor);
    }

    const inline = new Editor(new Renderer());
    inline.setSession(cloneSession(session));
    const cfg = getAceConfig();
    inline.setOptions(cfg.options); // font size, keyboard handler (vim) and the rest
    inline.setTheme(editor.getTheme());
    inline.container.style.height = "100%";

    const el = document.createElement("div");
    // resize: vertical + a ResizeObserver, the same pairing installResizablePopups
    // uses: CSS alone changes the box, not ace's idea of how tall it is.
    el.className = "ssf-inline-editor";
    el.style.cssText =
      "resize:vertical;overflow:hidden;border-top:2px solid #4a90d9;border-bottom:2px solid #4a90d9;height:" +
      Math.round(INLINE_EDITOR_ROWS * editor.renderer.layerConfig.lineHeight) +
      "px";
    el.appendChild(inline.container);

    const widget = { row: editor.getCursorPosition().row, fixedWidth: true, el, editor: inline };
    session.widgetManager.addLineWidget(widget);
    // The widget's height is measured off el.offsetHeight, and only for widgets the
    // manager has been told changed - so a drag has to say so, or the rows below
    // stay where they were and the editor is drawn over them.
    const observer = new ResizeObserver(() => {
      inline.resize(true);
      session.widgetManager.onWidgetChanged(widget);
    });
    observer.observe(el);

    adapter._inlineEditor = { widget, editor: inline, observer };
    // The same command on the inner editor, so it can close itself - it is an
    // editor of its own, with its own command set (as the diff's other side is).
    inline.commands.addCommands(inlineEditorCommands(adapter));
    inline.focus();
    return inline;
  }

  function inlineEditorCommands(adapter) {
    return [
      {
        name: "toggleInlineEditor",
        description: "Toggle inline editor at the cursor",
        // Deliberately not the demo's F3 (SAS Studio's Run Program) and not
        // Alt-Shift-E either, which is ace's own goToPreviousError.
        bindKey: { win: "Alt-Shift-I", mac: "Option-Shift-I" },
        exec: () => (adapter._inlineEditor ? closeInlineEditor(adapter) : openInlineEditor(adapter)),
        readOnly: true,
      },
    ];
  }

  // -- Diff in the current tab -----------------------------------------------------
  // ace's own diff views, INSIDE the focused tab rather than in an overlay, so the
  // tab keeps its caret, LSP registration and vim handler either way. Two shapes:
  // "split" puts a read-only editor for the other side beside the live one (the
  // pane is flexed and can be rotated a quarter turn at a time), "inline" draws the
  // other side into the live editor's own layers. Two sources: the last-saved text
  // (_savedLines, the baseline the unsaved-change gutter already keeps, so nothing
  // is re-read from the workspace) and any other file, picked in the browse prompt
  // and read from the workspace endpoint. Both prefs are persisted, so the diff
  // opens the way it was last left.
  // Quarter turns of the split, other side first: left|right -> top|bottom -> the
  // two mirrored. flex-direction is the whole implementation.
  const DIFF_LAYOUTS = ["row", "column", "row-reverse", "column-reverse"];

  // ssExt.diffPrefs is seeded by sw.js from chrome.storage.local's own `diffPrefs`
  // key. Deliberately NOT a corner of aceConfig: that object is rebuilt from a
  // fixed key whitelist by sw.js's and options.js's mergeAceConfig, so these two
  // were dropped on every round trip and pushed back into the page stale - which
  // is what made the mode toggle need two runs from inline and the layout rotation
  // start from 0 every time (and never persist).
  const diffPrefs = () => (ssExt.diffPrefs = Object.assign({ mode: "split", layout: 0 }, ssExt.diffPrefs));
  const diffMode = () => (diffPrefs().mode === "inline" ? "inline" : "split");
  const diffLayout = () => {
    const n = diffPrefs().layout;
    return typeof n === "number" ? ((n % DIFF_LAYOUTS.length) + DIFF_LAYOUTS.length) % DIFF_LAYOUTS.length : 0;
  };

  // relay.js is the only way from the MAIN world into chrome.storage. Nothing
  // pushes this back at us, so the in-page object stays authoritative.
  function persistDiffPrefs(changes) {
    const prefs = Object.assign(diffPrefs(), changes);
    window.postMessage({ __ssextDiffPrefs: prefs }, "*");
  }

  // Not the view's own gotoNext(): that one drives editorA - the OTHER side - and
  // reads the chunk's old range, i.e. that side's row numbers, so it repainted the
  // baseline's highlight and left the live caret where it was. Chunk starts in the
  // NEW range, on the live editor, are the whole job.
  function gotoDiffChunk(view, dir) {
    const editor = view.activeEditor || view.editorB;
    const rows = (view.chunks || []).map((c) => c.new.start.row);
    const row = editor.selection.lead.row;
    const target = dir > 0 ? rows.find((r) => r > row) : rows.filter((r) => r < row).pop();
    if (target === undefined) return;
    editor.gotoLine(target + 1, 0); // 1-based, and it scrolls the caret into view
  }

  // The four diff commands are EDITOR commands, registered once per editor and left
  // there: a command that comes and goes with the view could not be bound from ace's
  // settings menu or mapped from a vimrc (`nmap ]d <Cmd>gotoNextDiff`), which is the
  // point of them being commands rather than SSF_TOOLS actions.
  // `isAvailable` is what lets the nav pair keep Alt-Up/Alt-Down without stealing
  // them: ace holds several commands per key and `CommandManager.exec` walks them
  // newest-first until one runs, so with no diff open these decline and the keys go
  // on doing what they did before (ace's own movelinesup/down). Taking the binding
  // and giving it back by hand was the alternative, and removeCommand deletes a
  // binding outright rather than restoring what it displaced.
  function diffEditorCommands(adapter) {
    const view = () => adapter._diffView;
    const live = () => adapter.aceEditor;
    return [
      {
        name: "gotoNextDiff",
        description: "Goto next diff",
        bindKey: { win: "Alt-Down", mac: "Option-Down" },
        isAvailable: () => !!view(),
        exec: () => gotoDiffChunk(view(), 1),
        readOnly: true,
      },
      {
        name: "gotoPreviousDiff",
        description: "Goto previous diff",
        bindKey: { win: "Alt-Up", mac: "Option-Up" },
        isAvailable: () => !!view(),
        exec: () => gotoDiffChunk(view(), -1),
        readOnly: true,
      },
      {
        name: "toggleDiffSaved",
        description: "Toggle diff against last saved",
        exec: toggleDiffSaved,
        readOnly: true,
      },
      {
        name: "diffAgainstFile",
        description: "Toggle diff against another file…",
        exec: diffAgainstFile,
        readOnly: true,
      },
      {
        name: "toggleDiffMode",
        description: "Toggle diff split/inline",
        exec: toggleDiffMode,
        readOnly: true,
      },
      {
        name: "switchDiffPane",
        description: "Switch focus to other diff pane",
        // The inline view has one pane, so there is nothing to switch to.
        isAvailable: () => !!adapter._diffPane,
        exec: () => (live().isFocused() ? view().editorA : live()).focus(),
        readOnly: true,
      },
      {
        name: "rotateDiffLayout",
        description: "Rotate split diff layout",
        isAvailable: () => !!adapter._diffPane,
        exec: () => {
          persistDiffPrefs({ layout: (diffLayout() + 1) % DIFF_LAYOUTS.length });
          applyDiffLayout(adapter);
        },
        readOnly: true,
      },
    ];
  }

  // ace.edit() was given the tab's own pane node, so the editor IS that element and
  // there is nowhere inside it to put a second one: the second editor goes in beside
  // it and the parent is flexed. Everything touched is an inline style, recorded
  // here and put back by restore().
  function splitTabPane(adapter) {
    const live = adapter.aceEditor.container;
    const parent = live.parentNode;
    const saved = {
      display: parent.style.display,
      direction: parent.style.flexDirection,
      width: live.style.width,
      height: live.style.height,
    };
    const side = document.createElement("div");
    side.className = "ssext-diff-side";
    parent.style.display = "flex";
    parent.insertBefore(side, live); // the other side is pane one, see DIFF_LAYOUTS
    return {
      side,
      parent,
      restore() {
        side.remove();
        parent.style.display = saved.display;
        parent.style.flexDirection = saved.direction;
        live.style.width = saved.width;
        live.style.height = saved.height;
      },
    };
  }

  function applyDiffLayout(adapter) {
    const pane = adapter._diffPane;
    if (!pane) return;
    const direction = DIFF_LAYOUTS[diffLayout()];
    pane.parent.style.flexDirection = direction;
    const sideways = direction.indexOf("row") === 0;
    [pane.side, adapter.aceEditor.container].forEach((el) => {
      el.style.width = sideways ? "50%" : "100%";
      el.style.height = sideways ? "100%" : "50%";
    });
    adapter._diffView.editorA.resize(true);
    adapter.aceEditor.resize(true);
  }

  // Which file the other side is, kept on screen for as long as the diff is - a
  // toast said it once and was gone. The stock status bar rewrites its element's
  // textContent on every render (ace-patches.js's updateStatus), so this is a
  // second element on the same status line, pinned bottom-LEFT of whichever pane
  // holds the other side: the split's read-only editor, or the live one inline.
  function showDiffLabel(adapter, text) {
    const host = adapter._diffPane ? adapter._diffPane.side : adapter.aceEditor.container;
    const el = document.createElement("div");
    el.className = "ssf-ace-statusbar ssf-diff-label";
    // Bottom-right, like the status bar - and the split's read-only pane has no
    // status bar of its own, so there it IS the status line. Inline shares the
    // live editor's corner with the real one, so it sits a line above instead of
    // on top of it.
    el.style.cssText =
      "position:absolute;right:6px;z-index:9;opacity:0.65;pointer-events:none;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100% - 12px);" +
      (adapter._diffPane ? "bottom:2px" : "bottom:calc(2px + 1.4em)");
    el.style.fontSize = cssFontSize(getAceConfig().options && getAceConfig().options.fontSize);
    el.textContent = "◧ " + text;
    host.appendChild(el);
    adapter._diffLabel = el;
  }

  function closeDiff(adapter) {
    try {
      adapter._diffView.detach();
    } catch (e) {
      console.error("[SS Ext] diff view detach failed:", e);
    }
    adapter._diffView = null;
    if (adapter._diffLabel) adapter._diffLabel.remove();
    if (adapter._diffTeardown) adapter._diffTeardown();
    adapter._diffLabel = adapter._diffTeardown = adapter._diffPane = null;
    adapter.aceEditor.resize(true);
  }

  /**
   * Show `text` as the other side of a diff on the adapter's editor. `label` names
   * where it came from and stays on screen with it.
   */
  function openDiff(adapter, text, label) {
    const live = adapter.aceEditor;
    const diff = ace.require("ace/ext/diff");
    // createDiffView rather than `new SplitDiffView`/`new InlineDiffView`: the
    // constructors leave the module's dummy provider in place, which answers every
    // diff with no chunks at all - the factory is the only thing that installs the
    // real one.
    let view;
    if (diffMode() === "inline") {
      // inline "b": the live, still-editable text stays the active editor and only
      // the other side's layers are drawn in.
      view = diff.createDiffView({ editorB: live, inline: "b", valueA: text });
      // That side's session is built bare (new EditSession(valueA)), so without this
      // its rows render unhighlighted next to the live ones.
      view.sessionA.setMode(live.session.$modeId);
    } else {
      const pane = splitTabPane(adapter);
      const other = ace.edit(
        pane.side,
        Object.assign({}, getAceConfig().options, {
          mode: live.session.$modeId, // the other side is the same file type
          theme: live.getTheme(),
          readOnly: true, // it is a reference, not a second buffer to lose edits in
          value: text,
        }),
      );
      view = diff.createDiffView({ editorA: other, editorB: live });
      // The same commands on the read-only side, so switching back (and stepping
      // the diff) works from there too - it is an editor of its own, with its own
      // command set.
      other.commands.addCommands(diffEditorCommands(adapter));
      adapter._diffPane = pane;
      adapter._diffTeardown = () => {
        other.destroy();
        pane.restore();
      };
    }
    // Nothing in the view computes a first diff - onInput is only reached from an
    // edit (or a fold/wrap realign), so without this the freshly opened diff shows
    // no chunks at all until the next keystroke.
    view.onInput();
    adapter._diffView = view;
    adapter._diffOther = text; // kept so a mode flip can rebuild without re-reading
    adapter._diffLabelText = label || adapter._diffLabelText;
    if (adapter._diffPane) applyDiffLayout(adapter);
    showDiffLabel(adapter, adapter._diffLabelText);
    // The caret belongs in the live editor - after a pick in the browse prompt the
    // focus is wherever the prompt left it, and the nav keys are bound HERE.
    live.focus();
    return view;
  }

  /** The focused adapter, with the ace lib loaded - or null, having said why. */
  async function diffTarget() {
    if (!ssExt.libPath) {
      console.error("[SS Ext] diff: no libPath known yet - can't load the Ace library");
      return null;
    }
    await loadNewAce(ssExt.libPath); // ext-diff.js comes with it (the differ is already used)
    // An open diff can always be reached, even from the read-only side or with the
    // focus lost entirely - otherwise the split would be stuck open.
    const adapter = focusedAdapter() || allAdapters().find((a) => a._diffView);
    if (!adapter) {
      // Nothing focused, or the Ace replacement is off - either way there is no
      // adapter, and so no editor to split and no baseline to diff against.
      window.__ssf?.notify?.("Diff: focus an Ace editor first", true);
    }
    return adapter;
  }

  async function doToggleDiffSaved() {
    const adapter = await diffTarget();
    if (!adapter) return;
    if (adapter._diffView) return closeDiff(adapter);
    openDiff(adapter, (adapter._savedLines || []).join("\n"), "last saved");
  }

  async function doDiffAgainstFile() {
    const adapter = await diffTarget();
    if (!adapter) return;
    if (adapter._diffView) return closeDiff(adapter);

    // Deliberately NOT awaited: the prompt waits for a person, and the _pending
    // chain this runs in serializes every other ssExt action (toggle, browse, the
    // palette), so awaiting it here would leave them all blocked for as long as the
    // prompt stands open. browse() hands off the same way.
    ssExt.newLib.ace
      .require("ace/ext/browse_ss")
      .browse_ss.pick_file(
        (uri) => uri && openPickedFileDiff(adapter, uri),
        "Select the file to diff the current one against",
      );
  }

  async function openPickedFileDiff(adapter, uri) {
    // The tab may have been closed, or another diff opened, while the prompt was up.
    if (adapter._disposed || adapter._diffView) return;
    let text;
    try {
      text = await fetchWorkspaceFile(uri);
    } catch (e) {
      console.error("[SS Ext] diff: could not read", uri, e);
      window.__ssf?.notify?.(`Diff: could not read ${uri}`, true);
      return;
    }
    if (adapter._disposed || adapter._diffView) return; // ...or while it was fetched
    openDiff(adapter, text, uri);
  }

  // Flips the persisted shape, and rebuilds an open diff in it - from the text kept
  // on the adapter, so the other file isn't fetched again.
  async function doToggleDiffMode() {
    persistDiffPrefs({ mode: diffMode() === "inline" ? "split" : "inline" });
    const adapter = ssExt.newAceLoaded && (focusedAdapter() || allAdapters().find((a) => a._diffView));
    if (!adapter || !adapter._diffView) return;
    const text = adapter._diffOther;
    const label = adapter._diffLabelText;
    closeDiff(adapter);
    openDiff(adapter, text, label);
  }

  // GET of the same workspace URL saveTextViewer POSTs to. Like every other
  // session-bound request it queues behind a running program (ss-fixes' busy notice
  // says so), which is why nothing here has its own timeout.
  function fetchWorkspaceFile(uri) {
    const url =
      appDMS.baseURL +
      "/sasexec/sessions/" +
      appDMS.sessionId +
      "/workspace/" +
      encodeValue(uri, false, "/", false);
    return new Promise((resolve, reject) =>
      dojo.xhrGet({ url, handleAs: "text", preventCache: true, load: resolve, error: reject }),
    );
  }

  // All three serialized through the same _pending chain as toggle()/browse()/commandPalette().
  function toggleDiffSaved() {
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(doToggleDiffSaved, doToggleDiffSaved);
    return ssExt._pending;
  }

  function diffAgainstFile() {
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(doDiffAgainstFile, doDiffAgainstFile);
    return ssExt._pending;
  }

  function toggleDiffMode() {
    ssExt._pending = (ssExt._pending || Promise.resolve()).then(doToggleDiffMode, doToggleDiffMode);
    return ssExt._pending;
  }

  // -- Completion popup sizing ---------------------------------------------------
  // Ace never sizes the completion popup to its content - AcePopup stubs the
  // session's $computeWidth to 0, so the box is whatever the stylesheet says (our
  // 400px) and a long caption ellipsizes with the rest of the screen sitting empty
  // beside it. Measure the widest row on every open and grow the box to fit.
  // Only the editor's own popup goes through Autocomplete.openPopup; the prompt
  // lists (command palette, browse_ss) build their AcePopup directly and keep
  // sizing to their box.
  const POPUP_MIN_WIDTH = 400; // ssExtCompletionPopup's width, i.e. never narrower
  const POPUP_MAX_WIDTH = 800;
  /**
   * The size the user last dragged the editor's completion popup to, and from
   * then on its CEILING: content sizing still shrinks the box below it, nothing
   * grows it past it again. Width here, height as `lines` (see $autosize, which
   * feeds it back as $maxLines). Page session only, like promptSizes - dragging
   * a popup is a "not now" rather than a preference.
   */
  const completionPopupSize = {};

  /** @return true if the width changed (the caller then has to reposition). */
  function sizePopupToContent(popup) {
    const data = popup.data || [];
    const charWidth = popup.renderer.characterWidth;
    if (!data.length || !charWidth) return false;
    let cols = 0;
    for (const item of data) {
      const d = typeof item === "string" ? { caption: item } : item;
      const caption = d.caption || d.value || d.name || "";
      cols = Math.max(cols, caption.length + (d.meta || "").length + (d.message || "").length);
    }
    // +2 columns for the meta's 0.9em margin (a monospace char is ~0.6em, so two
    // of them cover it at any font size), +10px for the 8px .ace_text-layer keeps
    // free for the scrollbar and the popup's 1px borders.
    const want = Math.ceil((cols + 2) * charWidth) + 10;
    let width = Math.max(POPUP_MIN_WIDTH, Math.min(want, POPUP_MAX_WIDTH, window.innerWidth - 40));
    // A dragged width caps everything, the 400px floor included - somebody who
    // pulled the box in to 300 meant 300.
    if (completionPopupSize.width) width = Math.min(width, completionPopupSize.width);
    // No inline width yet = the stylesheet's, i.e. the minimum - so a popup of
    // short rows is left alone rather than written back at its own width.
    const current = Math.round(parseFloat(popup.container.style.width)) || POPUP_MIN_WIDTH;
    if (current === width) return false;
    popup.container.style.width = width + "px";
    // Remember what WE wrote, so the observer can tell this apart from a drag.
    popup.container.__ssExtAutoWidth = width;
    popup.renderer.onResize(true);
    return true;
  }

  function installAutosizeCompletionPopup(ace) {
    if (ssExt._popupAutosizePatched) return;
    ssExt._popupAutosizePatched = true;
    const proto = ace.require("ace/autocomplete").Autocomplete.prototype;
    const origOpenPopup = proto.openPopup;
    proto.openPopup = function () {
      origOpenPopup.apply(this, arguments);
      const popup = this.popup;
      // At openPopup time the popup hasn't rendered yet and characterWidth is
      // still 0 (measured), so wait for the render ace has just scheduled. The
      // listener is one-shot per open, so the re-render a width change causes
      // can't loop.
      // A width the user dragged is remembered by installResizablePopups and
      // caps this from then on (completionPopupSize), so reopening never grows
      // the box back past it.
      popup.renderer.once("afterRender", () => {
        if (sizePopupToContent(popup)) this.$updatePopupPosition();
      });
    };
  }

  // -- Resizable popups ---------------------------------------------------------
  // The CSS below puts a native resize handle on the completion popup and on the
  // two prompt boxes. CSS alone isn't enough: ace re-derives an autosizing
  // editor's height from $maxLines on every render, so a dragged height would be
  // undone by the next keystroke. Translate it back into lines instead ($minLines
  // too for the prompts, so a short list keeps the box the size it was dragged
  // to; the editor's own completion popup only gets the cap, since a tall empty
  // box floating at the caret is just in the way).
  //
  // This patches VirtualRenderer.prototype rather than wrapping AcePopup: both
  // ext-language_tools and ext-prompt capture AcePopup in a module closure when
  // they load, so by the time loadNewAce() can reach the export it's too late.
  // $autosize is the one hook that runs per popup render AND has the renderer, so
  // it doubles as the place to hand the observer its back-reference.
  const PROMPT_BOX_SEL = ".ace_prompt_container, .ace_browse_ss_container";
  /** Last dragged size per prompt box, by class name. Page session only. */
  const promptSizes = {};
  function installResizablePopups(ace) {
    if (ssExt._resizablePopupsPatched) return;
    ssExt._resizablePopupsPatched = true;
    const proto = ace.require("ace/virtual_renderer").VirtualRenderer.prototype;
    const origAutosize = proto.$autosize;
    const observer = new ResizeObserver(function (entries) {
      for (const entry of entries) {
        const el = entry.target;
        const r = el.__ssExtRenderer;
        // A prompt box: keep its list exactly as wide as it is. The list is
        // position:absolute, so its containing block is the full-screen overlay,
        // not the box - its width:100% is the whole window and it is the inline
        // max-width (600/800px, set by the prompt) that actually sizes it.
        if (!r) {
          const pop = el.querySelector(".ace_autocomplete");
          const cs = getComputedStyle(el);
          if (pop)
            pop.style.maxWidth =
              el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + "px";
          continue;
        }
        if (r.destroyed || !r.lineHeight) continue;
        // First sighting: each prompt open builds a fresh popup element, so the
        // size a user dragged only survives through promptSizes (page session
        // only - nothing is persisted to storage).
        if (el.__ssExtBox === undefined) {
          el.__ssExtBox = el.closest(PROMPT_BOX_SEL);
          if (el.__ssExtBox) {
            observer.observe(el.__ssExtBox);
            const saved = promptSizes[el.__ssExtBox.className];
            if (saved) {
              el.__ssExtLines = saved.lines;
              el.__ssExtBox.style.width = saved.width;
              r.onResize(true);
            }
          } else if (completionPopupSize.lines) {
            // The editor's own popup: ace reuses the element per editor, so this
            // only matters for the second editor of a page - but it is the same
            // ceiling either way.
            el.__ssExtLines = completionPopupSize.lines;
          }
        }
        const h = el.clientHeight;
        const w = el.clientWidth;
        // Hidden, or detached because the prompt just closed: nothing to measure,
        // and measuring anyway would save a junk size for the next open.
        if (!h || !w) continue;
        // A height ace didn't ask for is a user drag (tolerance: one line, since
        // desiredHeight includes borders/scroll margin that clientHeight doesn't).
        const dragged = Math.abs(h - r.desiredHeight) > r.lineHeight;
        if (dragged) {
          el.__ssExtLines = Math.max(1, Math.round(h / r.lineHeight));
          r.$maxPixelHeight = null;
        }
        if (dragged || w !== el.__ssExtWidth) r.onResize(true);
        el.__ssExtWidth = w;
        if (el.__ssExtBox) {
          promptSizes[el.__ssExtBox.className] = {
            lines: el.__ssExtLines,
            // The COMPUTED width - offsetWidth would add the padding back on
            // every open and the box would creep wider each time.
            width: getComputedStyle(el.__ssExtBox).width,
          };
          continue;
        }
        // The editor's completion popup. A width is only the user's if it is not
        // the one sizePopupToContent last wrote - that one runs on every open and
        // would otherwise save itself straight back as the ceiling.
        const styleWidth = Math.round(parseFloat(el.style.width)) || 0;
        if (styleWidth && styleWidth !== el.__ssExtAutoWidth) {
          completionPopupSize.width = styleWidth;
          // Adopt it as ours too, so the next resize event doesn't re-save it.
          el.__ssExtAutoWidth = styleWidth;
        }
        if (dragged) completionPopupSize.lines = el.__ssExtLines;
      }
    });
    proto.$autosize = function () {
      const el = this.container;
      if (!el.__ssExtRenderer && el.classList.contains("ace_autocomplete")) {
        el.__ssExtRenderer = this;
        observer.observe(el);
      }
      if (el.__ssExtLines) {
        this.$maxLines = el.__ssExtLines;
        if (el.__ssExtBox) this.$minLines = el.__ssExtLines;
      }
      return origAutosize.call(this);
    };
  }

  // In a prompt the completion list is NOT laid out inside the white box - ace's
  // own .ace_editor.ace_autocomplete is position:absolute, so the box is just the
  // input and the list floats below it at its static position. Hence two handles
  // with one job each: the box owns the WIDTH (the list follows it through the
  // width:100% rule in ssExtCompletionPopup), the list owns its own HEIGHT.
  // div.* (not .*) so this beats ace's own prompt sheet, which importCssString
  // prepends AFTER ours and so wins every same-specificity tie; a plain width
  // rather than ace's max-width:603px + width:100%, because a max-width would
  // clamp the drag. No !important anywhere - the inline width/height a drag
  // writes has to win.
  const RESIZABLE_CSS = `
    .ace_editor.ace_autocomplete { resize: both; }
    div.ace_prompt_container {
      width: 603px;
      max-width: 100%;
      resize: horizontal;
      overflow: hidden;
    }`;

  // -- Stock Ace settings panel (Ctrl-,/showSettingsMenu) persistence ------------
  // ext-settings_menu.js bundles its own "ace/ext/options" module (OptionPanel) -
  // that's the one showSettingsMenu's exec actually instantiates, so patching
  // this module's prototype (rather than a separately-loaded ext-options.js copy)
  // is what the stock panel is guaranteed to go through. Every user change funnels
  // SAS Studio's dijit.Dialog has two focus-grabbing paths that override an
  // open SS-Ext prompt (the command palette's ace_prompt_container and
  // browse_ss's ace_browse_ss_container - both z-index overlays without a
  // native focus trap, so dijit's trap wins):
  //   1. show()'s fadeIn onEnd autofocus: focus.focus(this._firstFocusItem) when
  //      this.autofocus && isTop - moves focus into a dialog that just opened
  //      behind our prompt.
  //   2. focus.watch("curNode") trap in dijit/Dialog: when focus moves to a node
  //      outside the top dialog's domNode, it calls dialog.focus() to yank it
  //      back - so the moment our cmdLine takes focus, the dialog steals it.
  // Suppress both while an SS-Ext prompt is open: skip show's autofocus, and
  // no-op dialog.focus() when the live focus is already inside our prompt.
  function installDialogFocusPriorityPatch() {
    if (ssExt._dialogFocusPatched) return;
    if (typeof dijit === "undefined" || !dijit.Dialog || !dijit.Dialog.prototype) return;
    ssExt._dialogFocusPatched = true;
    const PROMPT_SEL = ".ace_prompt_container, .ace_browse_ss_container";
    const promptOpen = () => !!document.querySelector(PROMPT_SEL);
    const focusInPrompt = () => {
      const ae = document.activeElement;
      return !!(ae && ae.closest && ae.closest(PROMPT_SEL));
    };
    try {
      const origShow = dijit.Dialog.prototype.show;
      dijit.Dialog.prototype.show = function () {
        if (promptOpen()) {
          const origAutofocus = this.autofocus;
          this.autofocus = false;
          const ret = origShow.apply(this, arguments);
          const restore = () => { this.autofocus = origAutofocus; };
          if (ret && typeof ret.then === "function") ret.then(restore, restore);
          else restore();
          return ret;
        }
        return origShow.apply(this, arguments);
      };
      const origFocus = dijit.Dialog.prototype.focus;
      dijit.Dialog.prototype.focus = function () {
        if (focusInPrompt()) return; // don't yank focus out of an SS-Ext prompt
        return origFocus.apply(this, arguments);
      };
    } catch (e) {
      console.error("[SS Ext] dialog focus-priority patch failed:", e);
    }
  }

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

  // ace's vim resolves a keystroke by taking the first FULL match and throwing
  // every partial match away (commandDispatcher.matchCommand) - it has no
  // timeoutlen to sit on an ambiguity the way real vim does. So a built-in
  // single-key alias permanently shadows any user mapping that STARTS with that
  // key: with `<Space>` -> `l` in the default keymap, `<Space>d` never got to
  // wait for the `d`, which is the whole reason Space could not be used as a
  // leader. Dropping the alias is what a vim user writes as `nnoremap <Space>
  // <Nop>`. Only `keyToKey` aliases go: those are pure conveniences (`<Space>`,
  // `<CR>`, `<BS>`, `s`/`S`), whereas the bare key of an operator (`d`, `c`,
  // `y`) has to keep working - so a mapping like `dd` stays shadowed, which is
  // true of real vim's own `dd` too.
  function dropShadowingAlias(keymap, lhs, ctx) {
    const first = (lhs.match(/^(?:<[^>]+>|[\s\S])/) || [])[0];
    if (!keymap || !first || first === lhs) return;
    for (let i = keymap.length - 1; i >= 0; i--) {
      const c = keymap[i];
      if (!c || c.keys !== first || c.type !== "keyToKey") continue;
      // Only the aliases that can actually shadow THIS mapping. A context-less
      // alias applies in every mode so it always can; a mode-specific one only
      // matters to a mapping in the same mode - `s` and `S` each have a normal
      // and a visual entry, and an `nmap sa` has no business breaking visual s.
      if (ctx && c.context && c.context !== ctx) continue;
      keymap.splice(i, 1);
    }
  }

  function applyVimrcLine(Vim, line, keymap) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '"') return;

    let m = trimmed.match(/^(n|i|v)?(nore)?map\s+(\S+)\s+(\S+)$/);
    if (m) {
      const ctx = m[1] ? VIMRC_CTX[m[1]] : undefined;
      // rhs <Cmd>name (vim 8.2's own form, with the <CR> optional since nothing
      // here is an ex command): map the key to an ACE command instead of to other
      // keys - ace's vim has an "aceCommand" action for exactly this, and it is the
      // only way to reach an editor command (the diff ones, say) from a vimrc.
      const cmd = m[4].match(/^<Cmd>(\w+)(?:<CR>)?$/i);
      if (cmd) {
        try {
          dropShadowingAlias(keymap, m[3], ctx);
          Vim.mapCommand(m[3], "action", "aceCommand", { name: cmd[1] }, ctx ? { context: ctx } : {});
        } catch (e) {
          console.error("[SS Ext] vimrc: failed to map ace command:", trimmed, e);
        }
        return;
      }
      try {
        dropShadowingAlias(keymap, m[3], ctx);
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
      const keymap = (vim.handler && vim.handler.defaultKeymap) || null;
      (text || "").split("\n").forEach((line) => applyVimrcLine(Vim, line, keymap));
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

  // The most recent palette commands (MRU list of entry.command keys in
  // chrome.storage via window._browseSsStore) are moved to the front of the entries array, so the last-run
  // command is the pre-selected first row when the palette reopens. Only
  // reorders entries that exist in the current list — editor commands aren't
  // built when no editor is focused, so they can't leak into the global
  // palette from history. The popup displays getCompletions' return order
  // (FilteredList.filterCompletions filters without sorting), so recents stay
  // on top while typing too, as long as they match.
  const CMD_HISTORY_KEY = "SsCmdPaletteHistory";
  const CMD_HISTORY_MAX = 5;

  // Command history persists in chrome.storage.local (via the same
  // window._browseSsStore relay as browse_ss history) so it survives "clear
  // site data". The store is created by ext-browse_ss.js, which loadNewAce()
  // loads before the palette can open.
  // A COPY, not the cached array itself: store.get() hands back the live object,
  // and buildPaletteEntries reverses what it gets. Reversing in place flipped the
  // MRU order of the cache on every palette OPEN, and the next accept persisted
  // that - so everything below the newest entry came back in the wrong order (and
  // flipped again on the next open). Measured against the real prompt; the smoke
  // test missed it by seeding the history object instead of accepting a row.
  function getCommandHistory() {
    const store = window._browseSsStore;
    return store ? (store.get(CMD_HISTORY_KEY) || []).slice() : [];
  }

  function recordCommandUse(command) {
    const store = window._browseSsStore;
    if (!store) return;
    const history = getCommandHistory().filter((c) => c !== command);
    history.unshift(command);
    store.set(CMD_HISTORY_KEY, history.slice(0, CMD_HISTORY_MAX));
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

    // Least-recent first, so the most recent ends up unshifted to index 0.
    getCommandHistory()
      .reverse()
      .forEach((cmd) => {
        const i = entries.findIndex((e) => e.command === cmd);
        if (i !== -1) {
          const item = entries.splice(i, 1)[0];
          item.message = "recent";
          entries.unshift(item);
        }
      });

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
        recordCommandUse(data.item.command);
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
    // Ensure the command-history cache is loaded from chrome.storage before
    // buildPaletteEntries reads it (first palette open on a fresh page).
    if (window._browseSsStore) await window._browseSsStore.ready(CMD_HISTORY_KEY);

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
