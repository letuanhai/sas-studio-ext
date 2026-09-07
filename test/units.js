/**
 * Pure-logic checks for the shared helpers in src/tools-meta.js and the
 * saslog fold mode - no browser, no live SAS Studio instance:
 * `npm run test:units`.
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
// ---------------------------------------------------------------------------
// src/editor-swap.js - the vim zj/zk/[z/]z row pickers. The file is a MAIN-world
// IIFE, but nothing at load time touches more than `window`, so it exposes its
// three pure helpers on __ssExt for exactly this.
require(path.join(__dirname, "..", "src", "editor-swap.js"));
const { nextFoldStart, prevFoldEnd, enclosingFold } = global.window.__ssExt._foldNav;

// Rows 1-8 = an outer fold, 2-4 and 6-7 = two siblings nested inside it.
const folds = { 1: [1, 8], 2: [2, 4], 6: [6, 7] };
const ends = { 4: true, 7: true, 8: true };
const doc = {
  getLength: () => 10,
  getFoldWidget: (r) => (folds[r] ? "start" : ends[r] ? "end" : ""),
  getFoldWidgetRange: (r) =>
    folds[r] && { start: { row: folds[r][0], column: 0 }, end: { row: folds[r][1], column: 0 } },
};

assert.equal(nextFoldStart(doc, 0), 1);
assert.equal(nextFoldStart(doc, 1), 2); // a nested fold below counts
assert.equal(nextFoldStart(doc, 4), 6);
assert.equal(nextFoldStart(doc, 6), null); // nothing below the last fold
assert.equal(prevFoldEnd(doc, 9), 8);
assert.equal(prevFoldEnd(doc, 8), 7);
assert.equal(prevFoldEnd(doc, 4), null); // still inside the outer fold, none closed yet
// The innermost enclosing fold wins, and a sibling that closed before the cursor
// (2-4, seen while walking up from row 5) must not be mistaken for it.
assert.deepEqual(enclosingFold(doc, 3).start.row, 2);
assert.deepEqual(enclosingFold(doc, 5).start.row, 1);
assert.deepEqual(enclosingFold(doc, 5).end.row, 8);
assert.equal(enclosingFold(doc, 1).start.row, 1); // on the start row: that fold, not the outer one
assert.equal(enclosingFold(doc, 0), null);
assert.equal(enclosingFold(doc, 9), null);

console.log("PASS  vim fold motions");
// ---------------------------------------------------------------------------
// src/editor-swap.js - the vim mark gutter decorations, read off the same
// editor.state.cm.state.vim.marks structure ace's vim keeps them in.
const { vimMarksOf, refreshVimMarkGutter } = global.window.__ssExt._vimMarks;

const mark = (line, ch) => ({ find: () => ({ line, ch }) });
const decorations = [];
const fakeEditor = {
  state: { cm: { state: { vim: { marks: { b: mark(7, 2), a: mark(3, 0), "<": mark(0, 0) } } } } },
  session: {
    addGutterDecoration: (row, cls) => decorations.push(["add", row, cls]),
    removeGutterDecoration: (row, cls) => decorations.push(["remove", row, cls]),
  },
};

// Sorted by name, and vim's own '<' bookkeeping mark is not a letter mark.
assert.deepEqual(vimMarksOf(fakeEditor), [
  { name: "a", row: 3, column: 0 },
  { name: "b", row: 7, column: 2 },
]);
assert.deepEqual(vimMarksOf({}), []); // no vim handler attached

refreshVimMarkGutter(fakeEditor);
// Class per mark by char code, so `a` (97) and `A` (65) can't collide.
assert.deepEqual(decorations, [
  ["add", 3, "ssExtVimMark-97"],
  ["add", 7, "ssExtVimMark-98"],
]);
decorations.length = 0;
refreshVimMarkGutter(fakeEditor);
assert.deepEqual(decorations, []); // unchanged marks must not re-render the gutter

// A moved mark clears its old row before decorating the new one.
fakeEditor.state.cm.state.vim.marks.a = mark(4, 0);
refreshVimMarkGutter(fakeEditor);
assert.deepEqual(decorations, [
  ["remove", 3, "ssExtVimMark-97"],
  ["remove", 7, "ssExtVimMark-98"],
  ["add", 4, "ssExtVimMark-97"],
  ["add", 7, "ssExtVimMark-98"],
]);

console.log("PASS  vim mark gutter");

// --- unsaved-change gutter: chunks -> gutter decorations ---------------------------
const { dirtyRowsFromChunks, sameLines } = global.window.__ssExt._dirtyGutter;

assert.ok(sameLines(["a", "b"], ["a", "b"]));
assert.ok(!sameLines(["a", "b"], ["a", "b", ""]));
assert.ok(!sameLines(["a"], ["b"]));

// An edit and an insert: every row of the new side gets the changed bar.
assert.deepEqual(
  dirtyRowsFromChunks(
    [
      { origStart: 2, origEnd: 3, editStart: 2, editEnd: 3 },
      { origStart: 7, origEnd: 7, editStart: 7, editEnd: 9 },
    ],
    12,
  ),
  [
    { row: 2, cls: "ssExtDirty" },
    { row: 7, cls: "ssExtDirty" },
    { row: 8, cls: "ssExtDirty" },
  ],
);

// A pure deletion has no row of its own - the row that closed the gap is marked,
// clamped to the last row when the deletion ran to the end of the file.
assert.deepEqual(dirtyRowsFromChunks([{ origStart: 4, origEnd: 6, editStart: 4, editEnd: 4 }], 9), [
  { row: 4, cls: "ssExtDirtyDel" },
]);
assert.deepEqual(dirtyRowsFromChunks([{ origStart: 9, origEnd: 12, editStart: 9, editEnd: 9 }], 9), [
  { row: 8, cls: "ssExtDirtyDel" },
]);

assert.deepEqual(dirtyRowsFromChunks([], 5), []);

console.log("PASS  unsaved-change gutter");

// --- browse prompt: per-extension Enter action -------------------------------------
const { ssfBrowseFileAction, SSF_BROWSE_FILE_ACTIONS, SSF_BROWSE_KEYS } = global.window;
const map = { sas: "open", lua: "text", zip: "reveal" };

assert.equal(ssfBrowseFileAction("/folders/myfolders/x.lua", map), "text");
assert.equal(ssfBrowseFileAction("X.LUA", map), "text"); // extension match is case-insensitive
assert.equal(ssfBrowseFileAction("/a/b/c.zip", map), "reveal");
assert.equal(ssfBrowseFileAction("/a/b/c.sas", map), "open");
assert.equal(ssfBrowseFileAction("/a/b/c.csv", map), ""); // unlisted -> the caller reveals it
assert.equal(ssfBrowseFileAction("/a/b/README", map), "");
assert.equal(ssfBrowseFileAction("/a/.luarc", map), ""); // a dotfile has no extension
assert.equal(ssfBrowseFileAction("/a/b/c.lua", undefined), ""); // nothing seeded yet

// Every action the options page offers must be a mode accept() understands, and
// each one has a key of its own in the prompt.
assert.deepEqual(
  SSF_BROWSE_FILE_ACTIONS.map((a) => a.name),
  ["open", "text", "reveal", "download"],
);
SSF_BROWSE_FILE_ACTIONS.forEach((a) =>
  assert.ok(
    SSF_BROWSE_KEYS.some((t) => t.name === a.tool),
    `${a.tool} missing from SSF_BROWSE_KEYS`,
  ),
);

console.log("PASS  browse prompt file actions");

// ---------------------------------------------------------------------------
// src/editor-swap.js - the vimrc parser dropping a built-in alias that would
// otherwise shadow a user mapping starting with the same key. ace's vim takes
// the first FULL match and discards partials, so `<Space>` -> `l` made
// `<Space>d` unreachable and Space unusable as a leader key.
const { applyVimrcLine, dropShadowingAlias } = global.window.__ssExt._vimrc;

const stockKeymap = () => [
  { keys: "<Space>", type: "keyToKey", toKeys: "l" },
  { keys: "<CR>", type: "keyToKey", toKeys: "j^", context: "normal" },
  { keys: "d", type: "operator", operator: "delete" },
  { keys: "s", type: "keyToKey", toKeys: "cl", context: "normal" },
];
const keysOf = (km) => km.map((c) => c.keys + ":" + c.type);

// a multi-key mapping drops the single-key alias that would shadow it
let km = stockKeymap();
dropShadowingAlias(km, "<Space>d");
assert.deepEqual(keysOf(km), ["<CR>:keyToKey", "d:operator", "s:keyToKey"]);

// ...but never an operator's own key: `dd` stays shadowed rather than breaking `d`
km = stockKeymap();
dropShadowingAlias(km, "dd");
assert.ok(
  km.some((c) => c.keys === "d" && c.type === "operator"),
  "the delete operator must survive a `dd` mapping",
);

// a single-key mapping replaces the alias outright, so nothing is dropped for it
km = stockKeymap();
dropShadowingAlias(km, "<Space>");
assert.equal(km.length, 4);

// angle-bracket names are one key, not one character
km = stockKeymap();
dropShadowingAlias(km, "<CR>x", undefined);
assert.ok(!km.some((c) => c.keys === "<CR>"));

// a mode-specific alias is only dropped for a mapping in that same mode: `s` has
// a normal and a visual entry, and `nmap sa` must not break visual-mode `s`.
km = [
  { keys: "s", type: "keyToKey", toKeys: "cl", context: "normal" },
  { keys: "s", type: "keyToKey", toKeys: "c", context: "visual" },
];
dropShadowingAlias(km, "sa", "normal");
assert.deepEqual(
  km.map((c) => c.context),
  ["visual"],
);

// a context-less alias shadows every mode, so it goes whatever the mapping's mode
km = stockKeymap();
dropShadowingAlias(km, "<Space>d", "normal");
assert.ok(!km.some((c) => c.keys === "<Space>"));

// and it is wired into the map branch of the parser, for every map flavour
for (const line of ["map <Space>d dd", "nmap <Space>d dd", "nnoremap <Space>d dd"]) {
  km = stockKeymap();
  const calls = [];
  const Vim = { map: (...a) => calls.push(["map", ...a]), noremap: (...a) => calls.push(["noremap", ...a]) };
  applyVimrcLine(Vim, line, km);
  assert.ok(!km.some((c) => c.keys === "<Space>"), `${line} left the alias in place`);
  assert.equal(calls.length, 1, line);
}

// an unmap line must not drop anything on its own
km = stockKeymap();
applyVimrcLine({ unmap: () => {} }, "unmap <Space>d", km);
assert.equal(km.length, 4);

// missing keymap (nothing loaded yet) must not throw
applyVimrcLine({ map: () => {} }, "map <Space>d dd", null);

console.log("PASS  vimrc alias shadowing (space as leader)");
