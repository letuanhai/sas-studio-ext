/**
 * ace/mode/saslog - the SAS mode plus, for a log, severity colours per line and
 * folding for the %INCLUDE blocks SAS writes into one:
 *
 *   NOTE: %INCLUDE (level 1) file /path/x.sas is file /path/x.sas.
 *   ...
 *   NOTE: %INCLUDE (level 1) ending.
 *
 * Used for .log files (ace-patches.js points ext/modelist's "log" entry here -
 * ace's own ace/mode/log has no file in this build and silently 404s).
 * Depends on ace/mode/sas already being registered: ace's define() has no
 * dynamic dependency loading, so editor-swap.js's loadNewAce() loads
 * mode-sas.js right before this file.
 */

__ssAce.define("ace/mode/folding/saslog", [], function (require, exports, module) {
  "use strict";
  var oop = require("../../lib/oop");
  var Range = require("../../range").Range;
  var BaseFoldMode = require("./sas").FoldMode;

  var START = /^NOTE: %INCLUDE \(level (\d+)\) file /;
  var END = /^NOTE: %INCLUDE \(level (\d+)\) ending\./;

  var FoldMode = (exports.FoldMode = function () {});
  oop.inherits(FoldMode, BaseFoldMode);

  (function () {
    this.getFoldWidgetSasLogBase = this.getFoldWidget;
    this.getFoldWidgetRangeSasLogBase = this.getFoldWidgetRange;

    this.getFoldWidget = function (session, foldStyle, row) {
      var line = session.getLine(row);
      if (START.test(line)) return "start";
      if (foldStyle === "markbeginend" && END.test(line)) return "end";
      return this.getFoldWidgetSasLogBase(session, foldStyle, row);
    };

    this.getFoldWidgetRange = function (session, foldStyle, row) {
      var line = session.getLine(row);
      var match = START.exec(line);
      if (match) return this.includeRange(session, row, match[1], 1);
      match = END.exec(line);
      if (match) return this.includeRange(session, row, match[1], -1);
      return this.getFoldWidgetRangeSasLogBase(session, foldStyle, row);
    };

    // SAS prints the nesting level itself, so a nested %INCLUDE always carries a
    // higher level and the first counterpart at the SAME level is the match - no
    // depth counting needed. The whole ending line is folded away with the body.
    this.includeRange = function (session, row, level, dir) {
      var re = dir === 1 ? END : START;
      var maxRow = session.getLength();
      for (var r = row + dir; r >= 0 && r < maxRow; r += dir) {
        var match = re.exec(session.getLine(r));
        if (!match || match[1] !== level) continue;
        var start = dir === 1 ? row : r;
        var end = dir === 1 ? r : row;
        return new Range(start, session.getLine(start).length, end, session.getLine(end).length);
      }
    };
  }).call(FoldMode.prototype);
});

__ssAce.define("ace/mode/saslog_highlight_rules", [], function (require, exports, module) {
  "use strict";
  var oop = require("../lib/oop");
  var dom = require("../lib/dom");
  var SasHighlightRules = require("./sas_highlight_rules").SasHighlightRules;

  // SAS's own convention (the Display Manager log, which SAS Studio's Log pane
  // follows): NOTE blue, WARNING green, ERROR red. INFO and DEBUG have no
  // colour there, so they get "extra information" and "noise" ones.
  // [light, dark] - the dark half is picked by the RENDERER's ace_dark class,
  // i.e. by the editor theme, not by the app's dark mode.
  // The token names are ours rather than TextMate scopes on purpose: no ace
  // theme has five severity scopes, and the nearest thing (.ace_invalid) is
  // absent from both defaults (chrome, gruvbox) and pink in dracula - see
  // SEMANTIC_SCOPE_ALIASES in docs/language-servers.md for the same trap. So nothing but the
  // sheet below paints these, which is what makes both themes work.
  var COLORS = {
    error: ["#cc0000", "#ff6b6b"],
    warning: ["#0a7a0a", "#6ccf6c"],
    note: ["#0057b8", "#6fb3ff"],
    info: ["#00727a", "#4fd0d8"],
    debug: ["#767676", "#9b9b9b"],
  };
  var KINDS = Object.keys(COLORS);

  dom.importCssString(
    KINDS.map(function (kind) {
      return (
        ".ace_saslog_" + kind + "{color:" + COLORS[kind][0] + "}\n" +
        ".ace_dark .ace_saslog_" + kind + "{color:" + COLORS[kind][1] + "}"
      );
    }).join("\n"),
    "ace_saslog"
  );

  // A marker line starts over from whatever state the previous line left us in.
  // The RESTART is the unshift into every state below; the stack clear is for
  // the embedded-language blocks the SAS rules push (PROC LUA/PYTHON
  // submit;...endsubmit;): leaving a NOTE: inside one carries that block's stack
  // along to the end of the file, so a later pop would land back in lua-start
  // mid-log. Highlighting is right either way - this is about not keeping a
  // stack that no longer describes anything.
  var restart = function (state) {
    return function (currentState, stack) {
      stack.length = 0;
      return state;
    };
  };

  // Whole line, not just the marker: the useful fact is "this line is an
  // error", and SAS Studio's own Log pane colours the line too.
  // SAS numbers some of them (ERROR 22-322:, WARNING 32-169:).
  // caseInsensitive is DELIBERATE, and declared here rather than inherited: ace
  // compiles one regex per state with a flag set shared by every rule in it, so
  // unshifting into the SAS states (which carry the flag) made these
  // case-insensitive by accident. Kept rather than fought, because a
  // hand-written `%put error: ...` means the same severity as SAS's own
  // uppercase marker - and declared so it cannot silently flip with a flag that
  // is not ours. Measured: with the SAS mode's own flag off, the state regex is
  // still `gi` with this line and `g` without it.
  var logRules = KINDS.map(function (kind) {
    return {
      token: "saslog_" + kind,
      regex: "^\\s*" + kind.toUpperCase() + "(?: \\d+-\\d+)?:.*$",
      caseInsensitive: true,
      next: restart("start"),
    };
  });

  var SasLogHighlightRules = function () {
    SasHighlightRules.call(this); // normalizeRules() has already run
    var rules = this.$rules;
    // EVERY state, not just `start`: an unbalanced quote in an echoed source
    // line leaves the SAS rules inside a string state that otherwise runs to the
    // end of the file, and a log is exactly where that happens - so a marker
    // line has to be recognisable from wherever the previous one left off.
    Object.keys(rules).forEach(function (key) {
      rules[key].unshift.apply(rules[key], logRules);
    });
    // Deliberately no second normalizeRules(): none of the rules added here
    // uses include/push/pop, so there is nothing left to normalize.
  };
  oop.inherits(SasLogHighlightRules, SasHighlightRules);

  exports.SasLogHighlightRules = SasLogHighlightRules;
});

__ssAce.define("ace/mode/saslog", [], function (require, exports, module) {
  "use strict";
  var oop = require("../lib/oop");
  var SasMode = require("./sas").Mode;
  var FoldMode = require("./folding/saslog").FoldMode;
  var SasLogHighlightRules = require("./saslog_highlight_rules").SasLogHighlightRules;

  var Mode = function () {
    SasMode.call(this);
    this.HighlightRules = SasLogHighlightRules;
    this.foldingRules = new FoldMode();
  };
  oop.inherits(Mode, SasMode);

  (function () {
    this.$id = "ace/mode/saslog";
  }).call(Mode.prototype);

  exports.Mode = Mode;
});
