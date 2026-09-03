/**
 * Runtime patches applied on top of the vendored ace 1.43.3 (lib/ace/, an
 * upstream build - only its module namespace is ours). These reproduce the
 * source modifications the project author made in the ace fork
 * (github.com/letuanhai/ace) — commits by letuanhai only — without touching
 * the vendored files, so lib/ace/ stays upstream code.
 *
 * Scope, tied to the fork's commits:
 *   - decorators.js  (d076a5bf, 96d537fd): theme-aware scrollbar cursor bar +
 *     selection-range bars in the scrollbar overview.
 *   - autocomplete.js + snippets.js (dc18672a): pass Esc through to vim mode.
 *   - ext/modelist.js (6a521be3): a SAS entry so the mode is listed, plus the
 *     "log" entry retargeted at our ace/mode/saslog.
 * The SAS mode/snippets themselves are separate files under src/ace/. The
 * fork's ext/statusbar.js changes are intentionally not reproduced — the
 * extension never loads that module.
 *
 * Call window.__ssExtApplyAcePatches(ace) once per loaded `ace` instance, after
 * ace.js (and, for the modelist patch, the ext-*.js that bundles ace/ext/modelist)
 * have loaded. Idempotent; each patch is guarded and independently try/catch'd.
 */
(function () {
  "use strict";

  function patchDecorators(ace) {
    // ace/layer/decorators: full replacement of $updateDecorators — the pristine
    // 1.43.3 body with the fork's two edits: the cursor bar's colour is made
    // theme-aware, and every selection range is drawn as a half-width bar.
    var Decorator = ace.require("ace/layer/decorators").Decorator;
    if (Decorator.prototype.$ssExtPatched) return;
    Decorator.prototype.$ssExtPatched = true;

    Decorator.prototype.$updateDecorators = function (config) {
      if (typeof this.canvas.getContext !== "function") {
        return;
      }
      var colors = (this.renderer.theme.isDark === true) ? this.colors.dark : this.colors.light;
      this.setDimensions(config);
      var ctx = this.canvas.getContext("2d");
      function compare(a, b) {
        if (a.priority < b.priority) return -1;
        if (a.priority > b.priority) return 1;
        return 0;
      }
      var annotations = this.renderer.session.$annotations;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (annotations) {
        var priorities = { info: 1, warning: 2, error: 3 };
        annotations.forEach(function (item) {
          item["priority"] = priorities[item.type] || null;
        });
        annotations = annotations.sort(compare);
        for (var i = 0; i < annotations.length; i++) {
          var row = annotations[i].row;
          var offset1 = this.getVerticalOffsetForRow(row);
          var offset2 = offset1 + this.lineHeight;
          var y1 = Math.round(this.heightRatio * offset1);
          var y2 = Math.round(this.heightRatio * offset2);
          var ycenter = Math.round((y1 + y2) / 2);
          var halfHeight = (y2 - ycenter);
          if (halfHeight < this.halfMinDecorationHeight) {
            halfHeight = this.halfMinDecorationHeight;
          }
          if (ycenter - halfHeight < 0) {
            ycenter = halfHeight;
          }
          if (ycenter + halfHeight > this.canvasHeight) {
            ycenter = this.canvasHeight - halfHeight;
          }
          var from = ycenter - halfHeight;
          var to = ycenter + halfHeight;
          var zoneHeight = to - from;
          ctx.fillStyle = colors[annotations[i].type] || null;
          ctx.fillRect(0, from, Math.round(this.oneZoneWidth - 1), zoneHeight);
        }
      }
      var cursor = this.renderer.session.selection.getCursor();
      if (cursor) {
        var currentY = Math.round(this.getVerticalOffsetForRow(cursor.row) * this.heightRatio);
        // fork d076a5bf: theme-aware instead of the fixed "rgba(0, 0, 0, 0.5)".
        ctx.fillStyle = (this.renderer.theme.isDark === true) ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)";
        ctx.fillRect(0, currentY, this.canvasWidth, 2);
      }
      // fork 96d537fd: draw each selection range as a half-width bar.
      var _this = this;
      var selections = this.renderer.session.selection.getAllRanges();
      if (selections) {
        selections.forEach(function (range) {
          var startY = Math.round(_this.getVerticalOffsetForRow(range.start.row) * _this.heightRatio);
          var endY = Math.round(_this.getVerticalOffsetForRow(range.end.row) * _this.heightRatio);
          ctx.fillStyle = "rgba(62, 200, 255, 0.5)";
          ctx.fillRect(0, startY, Math.round(_this.canvasWidth / 2), endY - startY);
        });
      }
    };
  }

  function forwardEscToVim(editor) {
    var keybinding = editor.getKeyboardHandler();
    if (keybinding && keybinding.$id && keybinding.$id === "ace/keyboard/vim")
      editor.keyBinding.onCommandKey({}, 0, 27);
  }

  function patchVimAwareEsc(ace) {
    // ace/autocomplete + ace/snippets (fork dc18672a): Esc while an autocomplete
    // popup or snippet tabstop is active normally just detaches, swallowing the
    // key and leaving vim stuck in insert mode. Forward Esc through after
    // detaching, but only when vim is the active handler.
    //
    // These modules live in ext-language_tools, not core ace.js — on pages that
    // don't load it (the options page) they're absent and the patch is inert, so
    // skip silently rather than throwing.
    var acMod = ace.require("ace/autocomplete");
    var Autocomplete = acMod && acMod.Autocomplete;
    if (Autocomplete && !Autocomplete.prototype.$ssExtEscPatched) {
      Autocomplete.prototype.$ssExtEscPatched = true;
      Autocomplete.prototype.commands["Esc"] = function (editor) {
        editor.completer.detach();
        forwardEscToVim(editor);
      };
    }

    patchTabstopManagerEsc(ace);
  }

  // `TabstopManager` (module ace/snippets) isn't exported - only a shared
  // instance (exports.snippetManager) is. Its prototype.keyboardHandler is a
  // *shared* HashHandler (one for every TabstopManager, not per-instance), so
  // grabbing it once via a throwaway editor and patching its "Esc" command in
  // place patches it for good.
  function patchTabstopManagerEsc(ace) {
    var snMod = ace.require("ace/snippets");
    var snippetManager = snMod && snMod.snippetManager;
    if (!snippetManager) return; // module not loaded on this page (e.g. options)
    var container = document.createElement("div");
    container.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;";
    document.body.appendChild(container);
    var editor;
    try {
      editor = ace.edit(container, { value: "x" });
      snippetManager.insertSnippetForSelection(editor, "$1");
      var TabstopManagerProto = Object.getPrototypeOf(editor.tabstopManager);
      if (!TabstopManagerProto.$ssExtEscPatched) {
        TabstopManagerProto.$ssExtEscPatched = true;
        var escCommand = TabstopManagerProto.keyboardHandler.commands["Esc"];
        var origExec = escCommand.exec;
        escCommand.exec = function (ed) {
          origExec(ed);
          forwardEscToVim(ed);
        };
      }
    } finally {
      if (editor) editor.destroy();
      container.remove();
    }
  }

  // Module-private `Mode` constructor in ace/ext/modelist isn't exported, so a
  // SAS entry can't be `new Mode(...)`'d from outside - clone an existing
  // instance's prototype instead (same public shape as the fork's `SAS: ["sas"]`
  // supportedModes entry once modelist processes it).
  function pushSasMode(modelist) {
    if (modelist.modesByName.sas) return;
    var proto = Object.getPrototypeOf(modelist.modes[0]);
    var sas = Object.create(proto);
    sas.name = "sas";
    sas.caption = "SAS";
    sas.mode = "ace/mode/sas";
    sas.extensions = "sas";
    sas.extRe = new RegExp("\\.(sas)$", "gi");
    modelist.modesByName.sas = sas;
    modelist.modes.push(sas);
  }

  function patchModelist(ace) {
    // ace/ext/modelist (fork 6a521be3): pristine has no SAS entry. ext-prompt.js
    // and ext-settings_menu.js each bundle their own copy, so this takes effect
    // once whichever file registers the module has loaded.
    var modelist = ace.require("ace/ext/modelist");
    pushSasMode(modelist);
    // .log -> ace/mode/saslog (src/ace/mode-saslog.js). modelist's own "Log"
    // entry points at ace/mode/log, which has no file in this build and 404s.
    if (modelist.modesByName.log && modelist.modesByName.log.mode !== "ace/mode/saslog") {
      modelist.modesByName.log.mode = "ace/mode/saslog";
      modelist.modesByName.log.caption = "SAS Log";
    }
  }

  function patchStatusbar(ace) {
    // ace/ext/statusbar (fork 177456b + 3a3e0a1): show "Line r/total (n selected),
    // Col c" with 1-based numbers instead of the terse "r:c" form. Full replacement
    // of updateStatus (pristine 1.43.3 body + the fork's edits). Skipped silently
    // when ext-statusbar isn't loaded (e.g. the options page).
    var mod = ace.require("ace/ext/statusbar");
    var StatusBar = mod && mod.StatusBar;
    if (!StatusBar || StatusBar.prototype.$ssExtPatched) return;
    StatusBar.prototype.$ssExtPatched = true;
    StatusBar.prototype.updateStatus = function (editor) {
      var status = [];
      function add(str, separator) {
        str && status.push(str, separator || "|");
      }
      add(editor.keyBinding.getStatusText(editor));
      if (editor.commands.recording) add("REC");
      var sel = editor.selection;
      var c = sel.lead;
      var linesSelected = "";
      if (!sel.isEmpty()) {
        var r = editor.getSelectionRange();
        linesSelected = " (" + (r.end.row - r.start.row + 1) + " selected)";
      }
      add(" Line " + (c.row + 1) + "/" + editor.session.getLength() + linesSelected + ", Col " + (c.column + 1) + " ");
      if (sel.rangeCount) add("[" + sel.rangeCount + "]", " ");
      status.pop();
      this.element.textContent = status.join("");
    };
  }

  window.__ssExtApplyAcePatches = function (ace) {
    if (!ace || typeof ace.require !== "function") return;
    [patchDecorators, patchVimAwareEsc, patchModelist, patchStatusbar].forEach(function (patch) {
      try {
        patch(ace);
      } catch (e) {
        console.error("[SS Ext] ace patch failed:", patch.name, e);
      }
    });
  };
})();
