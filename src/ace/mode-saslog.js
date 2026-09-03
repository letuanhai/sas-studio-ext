/**
 * ace/mode/saslog - the SAS mode plus folding for the %INCLUDE blocks SAS
 * writes into a log:
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

__ssAce.define("ace/mode/saslog", [], function (require, exports, module) {
  "use strict";
  var oop = require("../lib/oop");
  var SasMode = require("./sas").Mode;
  var FoldMode = require("./folding/saslog").FoldMode;

  var Mode = function () {
    SasMode.call(this);
    this.foldingRules = new FoldMode();
  };
  oop.inherits(Mode, SasMode);

  (function () {
    this.$id = "ace/mode/saslog";
  }).call(Mode.prototype);

  exports.Mode = Mode;
});
