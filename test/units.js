/**
 * Pure-logic checks for the shared helpers in src/tools-meta.js and the
 * saslog fold mode - no browser, no live SAS Studio instance:
 * `node test/units.js`.
 */
const assert = require("assert");
const path = require("path");

global.window = {};
require(path.join(__dirname, "..", "src", "tools-meta.js"));
const { ssfEventKey, ssfPatchEnabled, SSF_TOOLS } = global.window;

// macOS Option+<key> composes a character (or "Dead") into event.key - the
// physical key from event.code is what the hotkey has to match/record.
assert.equal(ssfEventKey({ altKey: true, code: "KeyN", key: "Dead" }), "n");
assert.equal(ssfEventKey({ altKey: true, code: "KeyE", key: "´" }), "e");
assert.equal(ssfEventKey({ altKey: true, shiftKey: true, code: "Digit5", key: "∞" }), "5");
// Punctuation: no letter/digit in the code name, so it comes from the layout table.
assert.equal(ssfEventKey({ altKey: true, code: "Period", key: "≥" }), ".");
assert.equal(ssfEventKey({ altKey: true, code: "BracketLeft", key: "“" }), "[");
assert.equal(ssfEventKey({ altKey: false, code: "KeyN", key: "n" }), "n");
assert.equal(ssfEventKey({ altKey: true, code: "F5", key: "F5" }), "F5");
assert.equal(ssfEventKey({ altKey: true, code: "AltLeft", key: "Alt" }), "Alt");

// A resolved layout map (options page -> sw.js -> ss-fixes) wins over the US table.
global.window.ssfKeyLayout.Semicolon = "ö";
assert.equal(ssfEventKey({ altKey: true, code: "Semicolon", key: "…" }), "ö");
delete global.window.ssfKeyLayout.Semicolon;
assert.equal(ssfEventKey({ altKey: true, code: "Semicolon", key: "…" }), ";");

const optIn = SSF_TOOLS.find((t) => t.name === "aceEditorOnLoad");
assert.equal(ssfPatchEnabled(optIn, {}), false);
assert.equal(ssfPatchEnabled(optIn, { aceEditorOnLoad: true }), true);
assert.equal(ssfPatchEnabled({ name: "keepAlive" }, {}), true);
assert.equal(ssfPatchEnabled({ name: "keepAlive" }, { keepAlive: false }), false);

console.log("PASS  tools-meta helpers");

// ---------------------------------------------------------------------------
// src/ace/mode-saslog.js - %INCLUDE block folding. A ~20-line stand-in for
// ace's module registry is enough: the fold mode only ever touches Range,
// oop.inherits and session.getLine/getLength.
const registry = {
  "ace/lib/oop": {
    inherits: (ctor, base) => {
      ctor.prototype = Object.create(base.prototype, { constructor: { value: ctor } });
    },
  },
  "ace/range": {
    Range: function (sr, sc, er, ec) {
      Object.assign(this, { start: { row: sr, column: sc }, end: { row: er, column: ec } });
    },
  },
  "ace/mode/sas": { Mode: function () {} },
  // Base fold mode: returns nothing for every non-%INCLUDE line.
  "ace/mode/folding/sas": {
    FoldMode: Object.assign(function () {}, {
      prototype: { getFoldWidget: () => "", getFoldWidgetRange: () => undefined },
    }),
  },
};
const payloads = {};
const normalize = (parentId, name) => {
  if (name[0] !== ".") return name;
  const parts = parentId.split("/").slice(0, -1);
  for (const part of name.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
};
const aceRequire = (id) => {
  if (!registry[id]) {
    const exports = {};
    registry[id] = exports;
    payloads[id]((name) => aceRequire(normalize(id, name)), exports, {});
  }
  return registry[id];
};
global.__ssAce = { define: (id, deps, payload) => (payloads[id] = payload) };
require(path.join(__dirname, "..", "src", "ace", "mode-saslog.js"));

const log = [
  "1    %include '/x/a.sas';",
  "NOTE: %INCLUDE (level 1) file /x/a.sas is file /x/a.sas.",
  "2    data one; run;",
  "NOTE: %INCLUDE (level 2) file /x/b.sas is file /x/b.sas.",
  "3    data two; run;",
  "NOTE: %INCLUDE (level 2) ending.",
  "NOTE: %INCLUDE (level 1) ending.",
  "NOTE: SAS Institute Inc.",
];
const session = { getLine: (r) => log[r], getLength: () => log.length };
const foldMode = new (aceRequire("ace/mode/folding/saslog").FoldMode)();
const widget = (row, style) => foldMode.getFoldWidget(session, style || "markbeginend", row);
const range = (row) => foldMode.getFoldWidgetRange(session, "markbeginend", row);

assert.equal(widget(1), "start");
assert.equal(widget(3), "start");
assert.equal(widget(5), "end");
assert.equal(widget(6), "end");
// Only "markbeginend" marks closing lines - the end widget must not appear
// under ace's default fold style (see DEFAULT_ACE_CONFIG.options.foldStyle).
assert.equal(widget(6, "markbegin"), "");
assert.equal(widget(0), "");
assert.equal(widget(7), "");

// A nested %INCLUDE has a higher level, so the first same-level counterpart is
// the match - the level-1 block must span past the whole level-2 one.
assert.deepEqual(range(1), { start: { row: 1, column: log[1].length }, end: { row: 6, column: log[6].length } });
assert.deepEqual(range(3), { start: { row: 3, column: log[3].length }, end: { row: 5, column: log[5].length } });
// Folding from the closing line yields the same range.
assert.deepEqual(range(6), range(1));
assert.deepEqual(range(5), range(3));
assert.equal(range(0), undefined);
// An unterminated block (truncated log) folds nothing rather than to the end.
const truncated = { getLine: (r) => log[r], getLength: () => 5 };
assert.equal(foldMode.getFoldWidgetRange(truncated, "markbeginend", 1), undefined);

console.log("PASS  saslog %INCLUDE folding");
