/**
 * Options page: patches (on/off), hotkeys (record/clear), editor config (theme
 * pair/keyboard handler/generic ace options), snippets (Ace editor + language
 * select + save).
 * Everything persists to chrome.storage.local; ss-fixes.js/editor-swap.js read
 * it back via sw.js's tabs.onUpdated injection and storage.onChanged pushes.
 */
(function () {
  "use strict";

  const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

  // The vendored build exports itself as window.__ssAce, not window.ace (see
  // tools/build_lib.sh's namespace rename - on the SAS Studio page that name is taken
  // by SAS's own ace). Nothing else on this page provides an `ace` global.
  const ace = window.__ssAce;

  // Ace-settings-panel options never saved into aceConfig (mirrors editor-swap.js):
  // "theme" is the options-page dark/light pair only; "mode" is per-file language,
  // never a saved default. Must stay in sync with editor-swap.js's copy.
  const NON_PERSISTED_ACE_OPTIONS = ["theme", "mode"];

  // Pasted by the user into the SAS Studio page's console, so it can assume only
  // what that page has: appDMS for the code tabs, __ssExt for the text viewers.
  // Deliberately not an extension feature - this answers "what is this command
  // called" once, while writing a vimrc, and the palette stays uncluttered.
  // Walks keyBinding.$handlers exactly like editor-swap.js's
  // getEditorCommandsByName, which is why a mode's or an extension's commands
  // show up and not just ace's built-ins.
  const CMD_IDS_SNIPPET = `(() => {
  const ed =
    (window.appDMS?.tabs?.getAllTabObjects?.() || [])
      .map((t) => t.editor?.editor?.aceEditor)
      .find(Boolean) ||
    (window.__ssExt?._textViewers || []).map((v) => v.adapter?.aceEditor).find(Boolean);
  if (!ed) return "No Ace editor found - open a code tab with the editor toggled ON.";
  const rows = [];
  (ed.keyBinding.$handlers || []).forEach((h) => {
    Object.keys(h.byName || {}).forEach((name) => {
      let key = h.byName[name].bindKey;
      if (typeof key !== "string") key = (key && key[h.platform]) || "";
      rows.push({ command: name, key, description: h.byName[name].description || "" });
    });
  });
  rows.sort((a, b) => a.command.localeCompare(b.command));
  console.table(rows);
  return rows.length + " commands - map one with: nmap gd <Cmd>" + (rows[0] || {}).command;
})();`;

  function hotkeyLabel(hotkey) {
    if (!hotkey || !hotkey.key) return "(unbound)";
    let name = hotkey.key;
    name = (hotkey.shiftKey ? "Shift+" : "") + name;
    name = (hotkey.altKey ? "Alt+" : "") + name;
    name = (hotkey.metaKey ? "Meta+" : "") + name;
    name = (hotkey.ctrlKey ? "Ctrl+" : "") + name;
    return name;
  }

  // -- Appearance -------------------------------------------------------------------

  // sw.js's storage.onChanged listener does the rest: re-registers the right
  // stylesheet for future loads and pushes it into the tabs already open.
  async function initDarkMode() {
    const select = document.getElementById("dark-mode");
    const { darkMode } = await chrome.storage.local.get("darkMode");
    select.value = darkMode || DEFAULT_DARK_MODE;
    select.addEventListener("change", () => chrome.storage.local.set({ darkMode: select.value }));
  }

  // -- Patches --------------------------------------------------------------------

  // Three-way, so a select rather than one of the patch checkboxes; read by
  // ss-fixes.js's runFocus patch via sw.js's __ssf.init(settings).
  async function initRunFocus() {
    const select = document.getElementById("run-focus");
    const { runFocus } = await chrome.storage.local.get("runFocus");
    select.value = runFocus || DEFAULT_RUN_FOCUS;
    select.addEventListener("change", () => chrome.storage.local.set({ runFocus: select.value }));
  }

  async function renderPatches() {
    const { fixes } = await chrome.storage.local.get("fixes");
    const saved = fixes || {};
    const container = document.getElementById("patches-list");

    window.SSF_TOOLS.filter((t) => t.kind === "patch").forEach((tool) => {
      const enabled = window.ssfPatchEnabled(tool, saved);

      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = enabled;
      checkbox.addEventListener("change", async () => {
        const { fixes } = await chrome.storage.local.get("fixes");
        const updated = fixes || {};
        updated[tool.name] = checkbox.checked;
        await chrome.storage.local.set({ fixes: updated });
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(tool.label));
      label.title = tool.title || "";
      container.appendChild(label);
    });
  }

  // -- Hotkeys ----------------------------------------------------------------------

  // Warn (don't block) when two actions in the same table share a key - which
  // one wins is whatever binds last.
  function flagDuplicateCells(cells) {
    const counts = {};
    cells.forEach((c) => {
      if (c.textContent !== "(unbound)") counts[c.textContent] = (counts[c.textContent] || 0) + 1;
    });
    cells.forEach((c) => {
      const dup = counts[c.textContent] > 1;
      c.classList.toggle("duplicate", dup);
      c.title = dup ? "Duplicate: another action uses this key" : "";
    });
  }

  // Record one keystroke: calls back with the event, or does nothing if the
  // recording is abandoned. Shared by both key tables.
  function recordKey(button, onKey) {
    button.textContent = "Press a key...";
    button.classList.add("recording");
    window.addEventListener("keydown", function onKeydown(event) {
      if (MODIFIER_KEYS.has(event.key)) return; // wait for a non-modifier key
      event.preventDefault();
      window.removeEventListener("keydown", onKeydown, true);
      button.textContent = "Record";
      button.classList.remove("recording");
      onKey(event);
    }, true);
  }

  async function renderHotkeys() {
    const { hotkeys } = await chrome.storage.local.get("hotkeys");
    const saved = hotkeys || {};
    const tbody = document.getElementById("hotkeys-list");
    const cells = [];
    const flagDuplicates = () => flagDuplicateCells(cells);

    window.SSF_TOOLS.filter((t) => t.kind === "action").forEach((tool) => {
      const current = Object.prototype.hasOwnProperty.call(saved, tool.name) ? saved[tool.name] : tool.hotkey;

      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = tool.label;
      nameCell.title = tool.title || "";
      row.appendChild(nameCell);

      const hotkeyCell = document.createElement("td");
      hotkeyCell.className = "hotkey-value";
      hotkeyCell.textContent = hotkeyLabel(current);
      row.appendChild(hotkeyCell);
      cells.push(hotkeyCell);

      const actionsCell = document.createElement("td");

      const recordBtn = document.createElement("button");
      recordBtn.textContent = "Record";
      actionsCell.appendChild(recordBtn);

      const clearBtn = document.createElement("button");
      clearBtn.textContent = "Clear";
      clearBtn.style.marginLeft = "6px";
      actionsCell.appendChild(clearBtn);

      row.appendChild(actionsCell);
      tbody.appendChild(row);

      async function saveHotkey(keymap) {
        const { hotkeys } = await chrome.storage.local.get("hotkeys");
        const updated = hotkeys || {};
        updated[tool.name] = keymap;
        await chrome.storage.local.set({ hotkeys: updated });
        hotkeyCell.textContent = hotkeyLabel(keymap);
        flagDuplicates();
      }

      clearBtn.addEventListener("click", () => saveHotkey(null));

      recordBtn.addEventListener("click", () =>
        recordKey(recordBtn, (event) =>
          saveHotkey({
            key: window.ssfEventKey(event),
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          })
        )
      );
    });

    flagDuplicates();
  }

  // -- Browse prompt keys -----------------------------------------------------------
  // These are ace bindings on the browse prompt's own command line, not global
  // hotkeys, so they're stored as ace key strings ("Alt-Shift-C") under a
  // separate storage key; sw.js seeds them onto __ssExt.browseKeys.

  // An ace binding with no modifier (or shift alone) that isn't a navigation/
  // function key is parsed as a TEXT binding by ace's MultiHashHandler, i.e. it
  // would fire while typing a path. Refuse to record those.
  function bindableAceKey(event) {
    const keys = ace.require("ace/lib/keys");
    if (event.ctrlKey || event.altKey || event.metaKey) return true;
    return !!keys.FUNCTION_KEYS[event.keyCode];
  }

  function aceKeyString(event) {
    const keys = ace.require("ace/lib/keys");
    return (
      (event.ctrlKey ? "Ctrl-" : "") +
      (event.altKey ? "Alt-" : "") +
      (event.metaKey ? "Cmd-" : "") +
      (event.shiftKey ? "Shift-" : "") +
      keys.keyCodeToString(event.keyCode)
    );
  }

  async function renderBrowseKeys() {
    const { browseKeys } = await chrome.storage.local.get("browseKeys");
    const saved = browseKeys || {};
    const tbody = document.getElementById("browse-keys-list");
    const cells = [];
    const flagDuplicates = () => flagDuplicateCells(cells);

    window.SSF_BROWSE_KEYS.forEach((tool) => {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = tool.label;
      row.appendChild(nameCell);

      const keyCell = document.createElement("td");
      keyCell.className = "hotkey-value";
      keyCell.textContent = window.ssfBrowseKeyLabel(window.ssfBrowseKeys(tool, saved));
      row.appendChild(keyCell);
      cells.push(keyCell);

      const actionsCell = document.createElement("td");

      const recordBtn = document.createElement("button");
      recordBtn.textContent = "Record";
      actionsCell.appendChild(recordBtn);

      const clearBtn = document.createElement("button");
      clearBtn.textContent = "Clear";
      clearBtn.style.marginLeft = "6px";
      actionsCell.appendChild(clearBtn);

      const resetBtn = document.createElement("button");
      resetBtn.textContent = "Default";
      resetBtn.style.marginLeft = "6px";
      actionsCell.appendChild(resetBtn);

      row.appendChild(actionsCell);
      tbody.appendChild(row);

      // null removes the entry, so the SSF_BROWSE_KEYS default applies again;
      // "" is a real value meaning "deliberately unbound".
      async function saveBrowseKey(binding) {
        const { browseKeys } = await chrome.storage.local.get("browseKeys");
        const updated = browseKeys || {};
        if (binding === null) delete updated[tool.name];
        else updated[tool.name] = binding;
        await chrome.storage.local.set({ browseKeys: updated });
        keyCell.textContent = window.ssfBrowseKeyLabel(window.ssfBrowseKeys(tool, updated));
        flagDuplicates();
      }

      clearBtn.addEventListener("click", () => saveBrowseKey(""));
      resetBtn.addEventListener("click", () => saveBrowseKey(null));

      recordBtn.addEventListener("click", () =>
        recordKey(recordBtn, (event) => {
          if (!bindableAceKey(event)) {
            recordBtn.textContent = "Needs a modifier";
            setTimeout(() => (recordBtn.textContent = "Record"), 1500);
            return;
          }
          saveBrowseKey(aceKeyString(event));
        })
      );
    });

    flagDuplicates();
  }

  // -- Per-extension Enter action (browse prompt) ------------------------------------
  // Stored as extension -> action name ("open"/"text"/"reveal"/"download"), the shape
  // ext-browse_ss.js indexes directly; the UI is the inverse (one extension list
  // per action), so it groups on render and flattens on save. A stored map
  // REPLACES DEFAULT_BROWSE_FILE_ACTIONS rather than merging, which is what makes
  // a default entry removable - hence "Restore defaults" rather than a per-row reset.
  async function renderBrowseFileActions() {
    const { browseFileActions } = await chrome.storage.local.get("browseFileActions");
    const stored = browseFileActions || DEFAULT_BROWSE_FILE_ACTIONS;
    const tbody = document.getElementById("browse-file-actions-list");
    const status = document.getElementById("browse-file-actions-status");
    const inputs = {};
    tbody.textContent = "";

    window.SSF_BROWSE_FILE_ACTIONS.forEach((action) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.textContent = action.label;
      row.appendChild(nameCell);

      const valueCell = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.style.width = "100%";
      input.value = Object.keys(stored)
        .filter((ext) => stored[ext] === action.name)
        .join(", ");
      inputs[action.name] = input;
      valueCell.appendChild(input);
      row.appendChild(valueCell);
      tbody.appendChild(row);

      input.addEventListener("change", save);
    });

    async function save() {
      const map = {};
      window.SSF_BROWSE_FILE_ACTIONS.forEach((action) => {
        inputs[action.name].value
          .toLowerCase()
          .split(",")
          // A leading dot is the natural way to type these, so accept it.
          .map((ext) => ext.trim().replace(/^\.+/, ""))
          .filter(Boolean)
          .forEach((ext) => (map[ext] = action.name));
      });
      await chrome.storage.local.set({ browseFileActions: map });
      status.textContent = "Saved";
      setTimeout(() => (status.textContent = ""), 1500);
    }

    document.getElementById("reset-browse-file-actions").onclick = async () => {
      await chrome.storage.local.remove("browseFileActions");
      renderBrowseFileActions();
    };
  }

  // -- Editor config (theme pair + keyboard handler + snippet editor) ---------------
  // Config flows both ways: this page writes chrome.storage.local.aceConfig (which
  // sw.js live-pushes into SAS Studio tabs via window.__ssExt.applyAceConfig), and
  // reads it back on storage.onChanged (e.g. after an in-page settings-panel change,
  // relayed by relay.js) so the selects and the snippet editor stay in sync.

  // Ace resolves "ace/keyboard/<name>" to keyboard-<name>.js by default, but the
  // vendored files are keybinding-<name>.js - same override as editor-swap.js's
  // loadNewAce, needed before any handler other than "" (Ace/none) can load.
  ace.config.set("basePath", "../lib/ace/src-noconflict");
  ["vim", "emacs", "sublime", "vscode"].forEach((name) => {
    ace.config.setModuleUrl(`ace/keyboard/${name}`, `../lib/ace/src-noconflict/keybinding-${name}.js`);
  });

  function mergeAceConfig(stored) {
    stored = stored || {};
    const defaults = window.DEFAULT_ACE_CONFIG || { darkTheme: "ace/theme/gruvbox", lightTheme: "ace/theme/iplastic", options: {}, vimrc: "", lsp: true, lspMaxLines: 500, luaLsp: true, procLuaLsp: false };
    return {
      darkTheme: stored.darkTheme || defaults.darkTheme,
      lightTheme: stored.lightTheme || defaults.lightTheme,
      options: Object.assign({}, defaults.options, stored.options || {}),
      // Unset -> default; a saved value wins even when empty (user cleared it).
      vimrc: typeof stored.vimrc === "string" ? stored.vimrc : defaults.vimrc,
      lsp: typeof stored.lsp === "boolean" ? stored.lsp : defaults.lsp,
      lspMaxLines: typeof stored.lspMaxLines === "number" ? stored.lspMaxLines : defaults.lspMaxLines,
      luaLsp: typeof stored.luaLsp === "boolean" ? stored.luaLsp : defaults.luaLsp,
      procLuaLsp: typeof stored.procLuaLsp === "boolean" ? stored.procLuaLsp : defaults.procLuaLsp,
    };
  }

  // -- vimrc parsing (duplicated from editor-swap.js's applyVimrcLine - the two
  // worlds can't share a file; keep this small). See options.html for the
  // supported-syntax note shown to the user.
  const VIMRC_CTX = { n: "normal", i: "insert", v: "visual" };

  // See editor-swap.js's copy for why a user mapping that starts with a
  // built-in keyToKey alias needs the alias removed first.
  function dropShadowingAlias(keymap, lhs, ctx) {
    const first = (lhs.match(/^(?:<[^>]+>|[\s\S])/) || [])[0];
    if (!keymap || !first || first === lhs) return;
    for (let i = keymap.length - 1; i >= 0; i--) {
      const c = keymap[i];
      if (!c || c.keys !== first || c.type !== "keyToKey") continue;
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

  function applyVimrcToSnippetsEditor(text) {
    ace.config.loadModule("ace/keyboard/vim", (vim) => {
      const Vim = vim && vim.Vim;
      if (!Vim) return;
      const keymap = (vim.handler && vim.handler.defaultKeymap) || null;
      (text || "").split("\n").forEach((line) => applyVimrcLine(Vim, line, keymap));
    });
  }

  let applying = false; // re-entrancy guard: our own storage.local.set shouldn't bounce back into itself

  async function initEditorConfig() {
    const themes = ace.require("ace/ext/themelist").themes;
    const darkSelect = document.getElementById("ace-dark-theme");
    const lightSelect = document.getElementById("ace-light-theme");
    const lspCheckbox = document.getElementById("ace-lsp");
    const lspMaxLinesInput = document.getElementById("ace-lsp-max-lines");
    const luaLspCheckbox = document.getElementById("ace-lua-lsp");
    const procLuaLspCheckbox = document.getElementById("ace-proc-lua-lsp");
    const vimrcEditor = document.getElementById("vimrc-editor");

    themes.forEach((t) => {
      darkSelect.appendChild(new Option(t.caption, t.theme));
      lightSelect.appendChild(new Option(t.caption, t.theme));
    });

    const snippetsEditor = ace.edit("snippets-editor");
    snippetsEditor.session.setMode("ace/mode/snippets");
    const languageTools = ace.require("ace/ext/language_tools");

    // Ace status bar overlay (same as the SAS editors - see editor-swap.js),
    // pinned to the snippet editor's bottom-right; font size tracks the config.
    let statusEl;
    try {
      const StatusBar = ace.require("ace/ext/statusbar").StatusBar;
      statusEl = document.createElement("div");
      statusEl.style.cssText =
        "position:absolute;right:6px;bottom:2px;z-index:9;opacity:0.65;pointer-events:none;white-space:nowrap;";
      document.getElementById("snippets-editor").appendChild(statusEl);
      new StatusBar(snippetsEditor, statusEl);
    } catch (e) {
      console.error("[SS Ext] snippet status bar unavailable:", e);
    }

    // OS dark/light still picks which of the pair is shown, matching the main
    // editor's own matchMedia machinery (editor-swap.js).
    const darkMql = window.matchMedia("(prefers-color-scheme: dark)");
    let current = mergeAceConfig(null);

    function applyToSnippetsEditor() {
      snippetsEditor.setTheme(darkMql.matches ? current.darkTheme : current.lightTheme);
      snippetsEditor.setOptions(current.options);
      // A snippet FILE needs its own words and Ace's snippet-authoring
      // templates, not the selected target language's keyword completer.
      snippetsEditor.completers = [languageTools.snippetCompleter, languageTools.textCompleter];
      snippetsEditor.setOptions({
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true,
        enableSnippets: true,
      });
      const fs = current.options && current.options.fontSize;
      if (statusEl && fs) statusEl.style.fontSize = typeof fs === "number" ? fs + "px" : fs;
    }

    function renderSelects() {
      darkSelect.value = current.darkTheme;
      lightSelect.value = current.lightTheme;
      lspCheckbox.checked = current.lsp !== false;
      lspMaxLinesInput.value = current.lspMaxLines;
      luaLspCheckbox.checked = current.luaLsp !== false;
      procLuaLspCheckbox.checked = current.procLuaLsp === true;
      vimrcEditor.value = current.vimrc || "";
    }

    async function persist() {
      applying = true;
      await chrome.storage.local.set({ aceConfig: current });
      applying = false;
    }

    const { aceConfig } = await chrome.storage.local.get("aceConfig");
    current = mergeAceConfig(aceConfig);
    renderSelects();
    applyToSnippetsEditor();
    applyVimrcToSnippetsEditor(current.vimrc);

    darkMql.addEventListener("change", applyToSnippetsEditor);
    darkSelect.addEventListener("change", () => {
      current.darkTheme = darkSelect.value;
      applyToSnippetsEditor();
      persist();
    });
    lightSelect.addEventListener("change", () => {
      current.lightTheme = lightSelect.value;
      applyToSnippetsEditor();
      persist();
    });
    lspCheckbox.addEventListener("change", () => {
      current.lsp = lspCheckbox.checked;
      persist();
    });
    luaLspCheckbox.addEventListener("change", () => {
      current.luaLsp = luaLspCheckbox.checked;
      persist();
    });
    procLuaLspCheckbox.addEventListener("change", () => {
      current.procLuaLsp = procLuaLspCheckbox.checked;
      persist();
    });
    lspMaxLinesInput.addEventListener("change", () => {
      const n = parseInt(lspMaxLinesInput.value, 10);
      current.lspMaxLines = Number.isNaN(n) || n < 0 ? 0 : n;
      lspMaxLinesInput.value = current.lspMaxLines;
      persist();
    });

    // The <Cmd> names a vimrc can map are ace command ids, and nothing in the UI
    // shows them: the palette lists DESCRIPTIONS ("Go to definition (language
    // server)" for gotoDefinition). Rather than crowd that list, hand over a
    // console one-liner - it reads the same source the palette does, every
    // handler on editor.keyBinding.$handlers, so it covers ace's own commands,
    // ours and anything a mode added.
    const cmdIdsText = document.getElementById("cmd-ids-text");
    cmdIdsText.value = CMD_IDS_SNIPPET;
    const cmdIdsBtn = document.getElementById("cmd-ids-copy");
    // No document.execCommand("copy") fallback here, unlike ss-fixes.js: that one
    // runs on the SAS Studio page, an INSECURE origin where navigator.clipboard
    // does not exist at all. This page is chrome-extension://, a secure context,
    // so writeText is always there and the deprecated call would be dead code.
    // A refusal is still possible (it needs the document focused), and the
    // honest answer to that is to say so rather than claim a copy that did not
    // happen - the text is selected, so Ctrl+C finishes the job.
    cmdIdsBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmdIdsText.value);
        cmdIdsBtn.textContent = "Copied";
      } catch (e) {
        console.error("[SS Ext] options: clipboard write refused:", e);
        cmdIdsText.focus();
        cmdIdsText.select();
        cmdIdsBtn.textContent = "Press Ctrl+C";
      }
      setTimeout(() => (cmdIdsBtn.textContent = "Copy"), 1600);
    });

    const vimrcStatus = document.getElementById("vimrc-save-status");
    document.getElementById("save-vimrc").addEventListener("click", () => {
      current.vimrc = vimrcEditor.value;
      applyVimrcToSnippetsEditor(current.vimrc);
      persist();
      vimrcStatus.textContent = "Saved.";
      setTimeout(() => (vimrcStatus.textContent = ""), 2000);
    });

    // Persist stock settings-menu (Ctrl-,) panel changes for the snippet editor
    // too - same prototype-level hook as editor-swap.js's installSettingsMenuPersistence,
    // patched once. ext-settings_menu.js is loaded via a <script> tag in
    // options.html, so "ace/ext/options" is already registered by the time this runs.
    if (!window.__ssfSettingsMenuPatched) {
      window.__ssfSettingsMenuPatched = true;
      try {
        const OptionPanel = ace.require("ace/ext/options").OptionPanel;
        const origSetOption = OptionPanel.prototype.setOption;
        OptionPanel.prototype.setOption = function (option, value) {
          origSetOption.call(this, option, value);
          if (NON_PERSISTED_ACE_OPTIONS.includes(option.path)) return; // never persist theme/mode
          current.options[option.path] = value;
          persist();
        };
      } catch (e) {
        console.error("[SS Ext] Failed to hook settings menu persistence:", e);
      }
    }

    // (The ace-patches are applied by an inline <script> in options.html, before
    // ext-settings_menu loads - see the comment there for why the ordering matters.)

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.aceConfig || applying) return;
      current = mergeAceConfig(changes.aceConfig.newValue);
      renderSelects();
      applyToSnippetsEditor();
      applyVimrcToSnippetsEditor(current.vimrc);
    });

    return snippetsEditor;
  }

  // -- Snippets ---------------------------------------------------------------------
  // One editor, one language at a time: `snippets` is a map of ace snippet scope
  // (the mode id's last segment, which is what snippetManager registers against)
  // -> snippet file text, and the select says which entry is in the box. The
  // languages come from ace/ext/modelist, so the list stays in step with ace -
  // including our own SAS/SAS Log entries, which ace-patches.js puts there.
  //
  // Switching language never loses anything and never writes anything: the text
  // of every language stays in `drafts` for the page's lifetime (marked "*" in
  // the select until saved), and Save writes them all at once.

  async function initSnippets(editor) {
    const select = document.getElementById("snippet-lang");
    const status = document.getElementById("save-status");
    const { snippets } = await chrome.storage.local.get("snippets");
    // Unset -> defaults, per language; a saved value wins even when empty.
    let saved = Object.assign({}, window.DEFAULT_SNIPPETS, snippets || {});
    const drafts = Object.assign({}, saved);
    let scope = "sas";
    const snippetManager = ace.require("ace/snippets").snippetManager;
    let editorSnippets = [];

    function applyEditorSnippets(text) {
      snippetManager.unregister(editorSnippets, "snippets");
      editorSnippets = text ? snippetManager.parseSnippetFile(text) : [];
      snippetManager.register(editorSnippets, "snippets");
    }

    const options = {}; // scope -> <option>, for the unsaved/has-snippets marker
    function addLanguage(name, caption) {
      if (options[name]) return;
      options[name] = new Option(caption, name);
      options[name].dataset.caption = caption;
      select.appendChild(options[name]);
    }

    ace
      .require("ace/ext/modelist")
      .modes.slice()
      .sort((a, b) => a.caption.localeCompare(b.caption))
      .forEach((m) => addLanguage(m.mode.split("/").pop(), m.caption));
    // A saved language modelist doesn't know (a mode that went away) still has to
    // be editable, or its snippets would be stuck in storage with no way back.
    Object.keys(drafts).forEach((s) => addLanguage(s, s));

    function mark(s) {
      const opt = options[s];
      if (!opt) return;
      const unsaved = (drafts[s] || "") !== (saved[s] || "");
      // Suffix, never prefix: a <select> type-ahead prefix-matches the option's
      // TEXT, and with 193 languages typing "s" for SAS is the only practical way
      // to reach one - a leading marker would take that away from exactly the
      // entries that have snippets.
      opt.textContent = opt.dataset.caption + (unsaved ? " *" : drafts[s] ? " •" : "");
    }

    function show(next) {
      scope = next;
      select.value = scope;
      editor.session.setMode("ace/mode/snippets");
      editor.setValue(drafts[scope] || "", -1);
      // One session holds every language in turn, so the swap itself is an
      // undoable delta: without this, Ctrl+Z in the box you just switched to
      // pulls in the PREVIOUS language's text, and the change handler saves it
      // as that language's snippets (measured). Undo history therefore does not
      // survive a language switch - same trade as the editor toggle in the page.
      editor.session.getUndoManager().reset();
    }

    // The box always uses ace/mode/snippets: the select chooses the registration
    // scope, not the syntax of the snippet body. The snippet mode has no worker,
    // but keep this explicit so a mode changed through Ace's settings menu does
    // not start a program-language worker against snippet-file syntax.
    editor.session.setUseWorker(false);

    editor.on("change", () => {
      drafts[scope] = editor.getValue();
      mark(scope);
    });
    select.addEventListener("change", () => {
      // Leaving the Snippets scope is also its local preview step: keep the
      // draft unsaved, but make its definitions usable in the snippet editor.
      if (scope === "snippets") applyEditorSnippets(drafts.snippets || "");
      show(select.value);
    });

    show(scope);
    Object.keys(options).forEach(mark);
    applyEditorSnippets(saved.snippets || "");

    document.getElementById("save-snippets").addEventListener("click", async () => {
      const map = {};
      Object.keys(drafts).forEach((s) => {
        // A deliberately emptied language that HAS a default is stored as "", so
        // the default doesn't come back; an empty one without is just dropped.
        if (drafts[s] || window.DEFAULT_SNIPPETS[s]) map[s] = drafts[s] || "";
      });
      await chrome.storage.local.set({ snippets: map });
      saved = Object.assign({}, map);
      applyEditorSnippets(saved.snippets || "");
      Object.keys(options).forEach(mark);
      status.textContent = "Saved.";
      setTimeout(() => (status.textContent = ""), 2000);
    });
  }

  initDarkMode();
  initRunFocus();
  renderPatches();
  // Resolve + persist the keyboard layout map before any hotkey is recorded;
  // this page is a secure context, the http SAS Studio page isn't, so this is
  // where it gets captured for both sides (see tools-meta.js).
  window.ssfLoadKeyLayout().then(renderHotkeys);
  // Browse keys are recorded from event.keyCode via ace's own key tables, so
  // they need no layout map - but they do need ace, which options.html loads.
  renderBrowseKeys();
  renderBrowseFileActions();
  initEditorConfig().then(initSnippets);
})();
