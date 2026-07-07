/**
 * Options page: patches (on/off), hotkeys (record/clear), editor config (theme
 * pair/keyboard handler/generic ace options), snippets (Ace editor + save).
 * Everything persists to chrome.storage.local; ss-fixes.js/editor-swap.js read
 * it back via sw.js's tabs.onUpdated injection and storage.onChanged pushes.
 */
(function () {
  "use strict";

  const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

  // Ace-settings-panel options never saved into aceConfig (mirrors editor-swap.js):
  // "theme" is the options-page dark/light pair only; "mode" is per-file language,
  // never a saved default. Must stay in sync with editor-swap.js's copy.
  const NON_PERSISTED_ACE_OPTIONS = ["theme", "mode"];

  function hotkeyLabel(hotkey) {
    if (!hotkey || !hotkey.key) return "(unbound)";
    let name = hotkey.key;
    name = (hotkey.shiftKey ? "Shift+" : "") + name;
    name = (hotkey.altKey ? "Alt+" : "") + name;
    name = (hotkey.metaKey ? "Meta+" : "") + name;
    name = (hotkey.ctrlKey ? "Ctrl+" : "") + name;
    return name;
  }

  // -- Patches --------------------------------------------------------------------

  async function renderPatches() {
    const { fixes } = await chrome.storage.local.get("fixes");
    const saved = fixes || {};
    const container = document.getElementById("patches-list");

    window.SSF_TOOLS.filter((t) => t.kind === "patch").forEach((tool) => {
      const enabled = saved[tool.name] !== false; // default: enabled

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

  async function renderHotkeys() {
    const { hotkeys } = await chrome.storage.local.get("hotkeys");
    const saved = hotkeys || {};
    const tbody = document.getElementById("hotkeys-list");

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
      }

      clearBtn.addEventListener("click", () => saveHotkey(null));

      recordBtn.addEventListener("click", () => {
        recordBtn.textContent = "Press a key...";
        recordBtn.classList.add("recording");

        function onKeydown(event) {
          if (MODIFIER_KEYS.has(event.key)) return; // wait for a non-modifier key
          event.preventDefault();
          window.removeEventListener("keydown", onKeydown, true);
          recordBtn.textContent = "Record";
          recordBtn.classList.remove("recording");

          const keymap = {
            key: event.key,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          };
          saveHotkey(keymap);
        }
        window.addEventListener("keydown", onKeydown, true);
      });
    });
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
    const defaults = window.DEFAULT_ACE_CONFIG || { darkTheme: "ace/theme/gruvbox", lightTheme: "ace/theme/iplastic", options: {}, vimrc: "", lsp: true, lspMaxLines: 500 };
    return {
      darkTheme: stored.darkTheme || defaults.darkTheme,
      lightTheme: stored.lightTheme || defaults.lightTheme,
      options: Object.assign({}, defaults.options, stored.options || {}),
      // Unset -> default; a saved value wins even when empty (user cleared it).
      vimrc: typeof stored.vimrc === "string" ? stored.vimrc : defaults.vimrc,
      lsp: typeof stored.lsp === "boolean" ? stored.lsp : defaults.lsp,
      lspMaxLines: typeof stored.lspMaxLines === "number" ? stored.lspMaxLines : defaults.lspMaxLines,
    };
  }

  // -- vimrc parsing (duplicated from editor-swap.js's applyVimrcLine - the two
  // worlds can't share a file; keep this small). See options.html for the
  // supported-syntax note shown to the user.
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

  function applyVimrcToSnippetsEditor(text) {
    ace.config.loadModule("ace/keyboard/vim", (vim) => {
      const Vim = vim && vim.Vim;
      if (!Vim) return;
      (text || "").split("\n").forEach((line) => applyVimrcLine(Vim, line));
    });
  }

  let applying = false; // re-entrancy guard: our own storage.local.set shouldn't bounce back into itself

  async function initEditorConfig() {
    const themes = ace.require("ace/ext/themelist").themes;
    const darkSelect = document.getElementById("ace-dark-theme");
    const lightSelect = document.getElementById("ace-light-theme");
    const lspCheckbox = document.getElementById("ace-lsp");
    const lspMaxLinesInput = document.getElementById("ace-lsp-max-lines");
    const vimrcEditor = document.getElementById("vimrc-editor");

    themes.forEach((t) => {
      darkSelect.appendChild(new Option(t.caption, t.theme));
      lightSelect.appendChild(new Option(t.caption, t.theme));
    });

    const snippetsEditor = ace.edit("snippets-editor");
    snippetsEditor.session.setMode("ace/mode/snippets");

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
      const fs = current.options && current.options.fontSize;
      if (statusEl && fs) statusEl.style.fontSize = typeof fs === "number" ? fs + "px" : fs;
    }

    function renderSelects() {
      darkSelect.value = current.darkTheme;
      lightSelect.value = current.lightTheme;
      lspCheckbox.checked = current.lsp !== false;
      lspMaxLinesInput.value = current.lspMaxLines;
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
    lspMaxLinesInput.addEventListener("change", () => {
      const n = parseInt(lspMaxLinesInput.value, 10);
      current.lspMaxLines = Number.isNaN(n) || n < 0 ? 0 : n;
      lspMaxLinesInput.value = current.lspMaxLines;
      persist();
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

  async function initSnippets(editor) {
    const { snippets } = await chrome.storage.local.get("snippets");
    // Unset -> defaults; a saved value wins even when empty (user cleared).
    const text = snippets && typeof snippets.sas === "string" ? snippets.sas : window.DEFAULT_SAS_SNIPPETS || "";
    editor.setValue(text, -1);

    const status = document.getElementById("save-status");
    document.getElementById("save-snippets").addEventListener("click", async () => {
      const text = editor.getValue();
      await chrome.storage.local.set({ snippets: { sas: text } });
      status.textContent = "Saved.";
      setTimeout(() => (status.textContent = ""), 2000);
    });
  }

  renderPatches();
  renderHotkeys();
  initEditorConfig().then(initSnippets);
})();
