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

// --- completion popup: width from the widest row ----------------------------------
const { sizePopupToContent, size: popupSize } = global.window.__ssExt._popupSizing;
global.window.innerWidth = 1600;

const fakePopup = (data, width) => ({
  data,
  renderer: { characterWidth: 10, onResize() {} },
  container: { style: { width } },
});

// Short captions leave the popup at its stylesheet width...
let p = fakePopup([{ caption: "abc", meta: "tab" }], "");
assert.equal(sizePopupToContent(p), false);
assert.equal(p.container.style.width, "");
// ...a long one grows it: (caption + meta + 2) * charWidth + 10.
p = fakePopup([{ caption: "x".repeat(40), meta: "SASHELP." }, { caption: "y" }], "");
assert.equal(sizePopupToContent(p), true);
assert.equal(p.container.style.width, "510px");
// Capped, and never wider than the window.
p = fakePopup([{ caption: "x".repeat(200) }], "");
sizePopupToContent(p);
assert.equal(p.container.style.width, "800px");
global.window.innerWidth = 600;
p = fakePopup([{ caption: "x".repeat(200) }], "");
sizePopupToContent(p);
assert.equal(p.container.style.width, "560px");
global.window.innerWidth = 1600;
// Re-opening on the same width is not a change, so nothing gets repositioned.
p = fakePopup([{ caption: "x".repeat(40), meta: "SASHELP." }], "510px");
assert.equal(sizePopupToContent(p), false);
// A dragged width becomes the ceiling, below the 400px floor as well as above.
popupSize().width = 300;
p = fakePopup([{ caption: "x".repeat(200) }], "");
sizePopupToContent(p);
assert.equal(p.container.style.width, "300px");
// ...and the auto width is recorded, so the resize observer can tell the two
// apart and not save our own write back as another drag.
assert.equal(p.container.__ssExtAutoWidth, 300);
popupSize().width = 600;
p = fakePopup([{ caption: "x".repeat(200) }], "");
sizePopupToContent(p);
assert.equal(p.container.style.width, "600px");
// Short rows still stay short - the saved size is a maximum, not a fixed width.
p = fakePopup([{ caption: "x".repeat(40), meta: "SASHELP." }], "");
sizePopupToContent(p);
assert.equal(p.container.style.width, "510px");
delete popupSize().width;

// Nothing measurable yet (no rows, or a popup that hasn't rendered).
assert.equal(sizePopupToContent(fakePopup([], "")), false);
assert.equal(
  sizePopupToContent({
    data: [{ caption: "x".repeat(40) }],
    renderer: { characterWidth: 0, onResize() {} },
    container: { style: { width: "" } },
  }),
  false,
);

console.log("PASS  completion popup width");

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

// an <Cmd> rhs maps the key to an ACE command (vim's aceCommand action) instead of
// to other keys - the only way to reach an editor command from a vimrc.
km = stockKeymap();
let mapped = [];
const cmdVim = {
  map: () => assert.fail("map must not be used for a <Cmd> rhs"),
  noremap: () => assert.fail("noremap must not be used for a <Cmd> rhs"),
  mapCommand: (...a) => mapped.push(a),
};
applyVimrcLine(cmdVim, "nmap <Space>d <Cmd>gotoNextDiff", km);
assert.deepEqual(mapped, [
  ["<Space>d", "action", "aceCommand", { name: "gotoNextDiff" }, { context: "normal" }],
]);
// the leader alias goes for these too, and the <CR> vim itself needs is optional
assert.ok(!km.some((c) => c.keys === "<Space>"));
mapped = [];
applyVimrcLine(cmdVim, "map gn <Cmd>gotoNextDiff<CR>", stockKeymap());
assert.deepEqual(mapped, [["gn", "action", "aceCommand", { name: "gotoNextDiff" }, {}]]);

console.log("PASS  vimrc alias shadowing (space as leader)");
console.log("PASS  vimrc <Cmd> maps a key to an ace command");

// ---------------------------------------------------------------------------
// src/editor-swap.js - the sas.<name> DATA step function completions, whose
// names and docs come from the SAS language server at runtime.
const { mdToText, afterSasDot, sasDotWordAt } = global.window.__ssExt._sasFns;

const line = (text) => ({ getLine: () => text });
assert.equal(afterSasDot(line("  local n = sas.pu"), { row: 0, column: 18 }, "pu"), true);
assert.equal(afterSasDot(line("  sas.putn("), { row: 0, column: 10 }, "putn"), true);
assert.equal(afterSasDot(line("  local sast = pu"), { row: 0, column: 17 }, "pu"), false);
assert.equal(afterSasDot(line("  s.pu"), { row: 0, column: 6 }, "pu"), false);

// The server answers markdown; ace's doc tooltip takes plain text.
assert.equal(
  mdToText(
    "Keyword:  [SUBSTRN](https://example.com/x.htm)\n\n" +
      "Syntax: SUBSTRN (*string*, *position*&lt;, *length*&gt;)\n\n" +
      '<span style="white-space:pre-wrap;">Returns a substring.</span>',
  ),
  "Keyword:  SUBSTRN\n\nSyntax: SUBSTRN (*string*, *position*<, *length*>)\n\nReturns a substring.",
);
assert.equal(mdToText(""), "");

// Hover reads the whole name the caret sits in, not just what is behind it.
assert.deepEqual(sasDotWordAt(line("x = sas.today()"), { row: 0, column: 10 }), {
  name: "today",
  column: 8,
});
assert.deepEqual(sasDotWordAt(line("x = sas.today()"), { row: 0, column: 13 }), {
  name: "today",
  column: 8,
});
assert.equal(sasDotWordAt(line("x = sas.t"), { row: 0, column: 9 }), null); // too short to ask
assert.equal(sasDotWordAt(line("x = mysas.today()"), { row: 0, column: 12 }), null);

console.log("PASS  sas.<name> function completions");

// ---------------------------------------------------------------------------
// src/editor-swap.js - the Lua inside PROC LUA submit;...endsubmit; blocks. The
// document handed to the Lua server is the SAS file with every non-Lua line
// blanked, so an LSP line/character IS an ace row/column - which is only true
// if the ranges are right.
const procLua = global.window.__ssExt._procLua;
const src = [
  "data one; set two; run;", // 0
  "proc lua;", // 1
  "  submit;", // 2
  "    local x = 1", // 3
  "    print(x)", // 4
  "  endsubmit;", // 5
  "run;", // 6
  "proc print data=one; run;", // 7
].join("\n");
const lines = src.split("\n");
assert.deepEqual(procLua.luaRanges(lines), [[3, 4]], "the fence lines themselves are SAS");
assert.equal(procLua.inLuaRange([[3, 4]], 3), true);
assert.equal(procLua.inLuaRange([[3, 4]], 5), false);
// Every non-Lua line is blank, and the Lua ones are untouched at their own row.
assert.deepEqual(procLua.blankNonLua(lines, [[3, 4]]).split("\n"), [
  "",
  "",
  "",
  "    local x = 1",
  "    print(x)",
  "",
  "",
  "",
]);
// An unclosed block runs to the end of the file (you are typing inside it).
assert.deepEqual(procLua.luaRanges(["proc lua;", "submit;", "x = 1"]), [[2, 2]]);
// `submit` on the proc line itself, and a step that ends without ever submitting.
assert.deepEqual(procLua.luaRanges(["proc lua; submit;", "x = 1", "endsubmit;"]), [[1, 1]]);
assert.deepEqual(procLua.luaRanges(["proc lua;", "run;", "x = 1"]), []);
// "endsubmit" must not read as an opening "submit" - there is no word boundary
// inside it, which is the whole reason the two tests can share a line scan.
assert.deepEqual(procLua.luaRanges(["proc lua;", "submit;", "a", "endsubmit;", "b"]), [[2, 2]]);

console.log("PASS  proc lua block ranges");

// Format edits come back against the document as it was, so they are applied
// last-first; and anything outside the block's rows is dropped, since those rows
// are the SAS the blanking hid from the formatter.
const edit = (sl, sc, el, ec, newText) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});
assert.deepEqual(
  procLua
    .orderedEdits(
      [edit(3, 0, 3, 4, "a"), edit(4, 2, 4, 6, "b"), edit(3, 8, 3, 9, "c")],
      [3, 4],
    )
    .map((e) => e.newText),
  ["b", "c", "a"],
);
// A blank-line collapse reaching outside the block, and one wholly outside it.
assert.deepEqual(
  procLua.orderedEdits([edit(2, 0, 3, 0, ""), edit(6, 0, 6, 1, "x")], [3, 4]),
  [],
);
assert.deepEqual(procLua.orderedEdits(null, [3, 4]), []);
// A whole-block format states its end as (to + 1, 0) - the row after the last
// one, at column 0 - which touches nothing below the block and must be kept.
assert.equal(procLua.orderedEdits([edit(3, 0, 5, 0, "x\n")], [3, 4]).length, 1);
assert.equal(procLua.orderedEdits([edit(3, 0, 5, 1, "x\n")], [3, 4]).length, 0);
// ...but that allowance must not let an edit START on the row after the block:
// a zero-width edit at (to + 1, 0) satisfies the end clause and would apply as
// an insert into the `endsubmit;` line, i.e. straight into SAS code.
assert.equal(procLua.orderedEdits([edit(5, 0, 5, 0, "WRECK")], [3, 4]).length, 0);
assert.equal(procLua.orderedEdits([edit(5, 0, 5, 3, "WRECK")], [3, 4]).length, 0);

// Two edits at the SAME position keep the order the server sent them in - LSP
// says that is the order their text appears - so applying last-first has to
// reverse the tie as well, or the second one's text lands in front.
assert.deepEqual(
  procLua.orderedEdits([edit(3, 2, 3, 2, "A"), edit(3, 2, 3, 2, "Z")], [3, 4]).map((e) => e.newText),
  ["Z", "A"],
);

// The formatter sees the block's Lua at the top level and returns it flush
// against column 0, so the block's own base indent goes back on every line -
// but not on a first line that starts mid-row, which is already past an indent.
assert.deepEqual(
  procLua.reindentEdits([edit(3, 0, 5, 0, "local x = 1\nif x then\n    print(x)\nend\n")], "  "),
  [edit(3, 0, 5, 0, "  local x = 1\n  if x then\n      print(x)\n  end\n")],
);
assert.deepEqual(procLua.reindentEdits([edit(3, 8, 3, 9, "a\nb")], "  "), [
  edit(3, 8, 3, 9, "a\n  b"),
]);
assert.deepEqual(procLua.reindentEdits([edit(3, 0, 3, 1, "a")], ""), [edit(3, 0, 3, 1, "a")]);
// A whole-newText deletion at column 0 is a formatter stripping the indent: the
// indent has to go back, or that row ends up flush against column 0. A blank
// line INSIDE a multi-line replacement still gets none.
assert.deepEqual(procLua.reindentEdits([edit(3, 0, 3, 2, "")], "  "), [edit(3, 0, 3, 2, "  ")]);
assert.deepEqual(procLua.reindentEdits([edit(3, 0, 5, 0, "a\n\nb\n")], "  "), [
  edit(3, 0, 5, 0, "  a\n\n  b\n"),
]);

console.log("PASS  proc lua format edits");

// textDocument/definition answers any of three shapes, and emmylua uses two of
// them: a bare Location for a hit in the same document, an array for a
// cross-file one. LocationLink is the third the spec permits.
const { firstLspLocation } = global.window.__ssExt._luaNav;
const loc = (uri, line, ch) => ({ uri, range: { start: { line, character: ch }, end: { line, character: ch + 3 } } });
assert.deepEqual(firstLspLocation(loc("file:///a.lua", 3, 10)), loc("file:///a.lua", 3, 10));
assert.deepEqual(
  firstLspLocation([loc("file:///a.lua", 1, 2), loc("file:///b.lua", 9, 0)]),
  loc("file:///a.lua", 1, 2),
);
assert.deepEqual(
  firstLspLocation([
    {
      targetUri: "file:///a.lua",
      targetRange: loc("x", 0, 0).range,
      targetSelectionRange: loc("x", 4, 6).range,
    },
  ]),
  // the SELECTION range is the name itself, which is where a jump should land
  { uri: "file:///a.lua", range: loc("x", 4, 6).range },
);
assert.equal(firstLspLocation(null), null);
assert.equal(firstLspLocation([]), null);
assert.equal(firstLspLocation({ nonsense: 1 }), null);

// A rename inside a block may only touch rows the block owns: the blanked
// document hides the surrounding SAS, so an edit landing there would be written
// into SAS code.
const { blockEditsInside } = global.window.__ssExt._luaNav;
const at = (sl, sc, el, ec) => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } } });
assert.equal(blockEditsInside([[3, 5]], [at(3, 0, 3, 4), at(5, 2, 5, 9)]), true);
assert.equal(blockEditsInside([[3, 5]], [at(3, 0, 3, 4), at(6, 0, 6, 1)]), false);
assert.equal(blockEditsInside([[3, 5]], [at(2, 0, 4, 0)]), false); // spans out of the top
assert.equal(blockEditsInside([[3, 5]], [at(5, 0, 6, 0)]), false); // and out of the bottom
assert.equal(blockEditsInside(null, [at(3, 0, 3, 1)]), false); // no block at all
assert.equal(blockEditsInside([[3, 5]], []), true);

console.log("PASS  lsp definition location shapes");

// The semantic tokens for a block come back in the LSP wire format - five ints
// per token, the first two delta-encoded - and have to become the same ace
// scopes ace-linters produces for a .lua file, or the colours differ.
const { decodeSemanticTokens } = global.window.__ssExt._procLuaTokens;
const legend = {
  tokenTypes: ["namespace", "class", "function", "method", "variable"],
  tokenModifiers: ["declaration", "static", "readonly"],
};
// row 3 col 4 len 2 "class"; same row, +7 cols, len 4 "method" (+static);
// two rows down, col 8 (absolute again, the row changed), len 3 "variable".
const decoded = decodeSemanticTokens([3, 4, 2, 1, 0, 0, 7, 4, 3, 2, 2, 8, 3, 4, 0], legend);
assert.deepEqual(decoded, [
  { row: 3, startColumn: 4, length: 2, type: "entity.name.type.class" },
  { row: 3, startColumn: 11, length: 4, type: "entity.name.function.member.static" },
  { row: 5, startColumn: 8, length: 3, type: "entity.name.variable" },
]);
// A type the legend doesn't name is skipped rather than mislabelled, and a type
// with no scope of its own passes through under its own name.
assert.deepEqual(decodeSemanticTokens([0, 0, 1, 99, 0], legend), []);
assert.deepEqual(decodeSemanticTokens([0, 0, 1, 0, 0], legend), [
  { row: 0, startColumn: 0, length: 1, type: "entity.name.namespace" },
]);
assert.deepEqual(decodeSemanticTokens(null, legend), []);
assert.deepEqual(decodeSemanticTokens([0, 0, 1, 0, 0], null), []);

// The signature tooltip: the active parameter is bolded (that IS the argument
// highlight) and the documentation goes underneath.
const { signatureTooltip } = global.window.__ssExt._procLuaSignature;
const help = {
  activeParameter: 1,
  signatures: [
    {
      label: "sas.sleep(amount: number, unit: number?)",
      parameters: [{ label: "amount: number" }, { label: "unit: number?" }],
      documentation: { value: "Sleep for `amount` units." },
    },
  ],
};
assert.equal(
  signatureTooltip(help).content.text,
  "sas.sleep(amount: number, **unit: number?**)\n\nSleep for `amount` units.",
);
assert.equal(signatureTooltip({ signatures: [] }), undefined);
assert.equal(signatureTooltip(null), undefined);

console.log("PASS  proc lua semantic tokens and signature tooltip");

// ---------------------------------------------------------------------------
// src/editor-swap.js - LSP semantic token scopes rewritten onto scopes ace
// themes actually style (see themedSemanticScope for why).
const semanticScope = global.window.__ssExt._semanticScope;

// Longest prefix wins, and the modifiers ride along.
assert.equal(semanticScope("entity.name.function.member"), "support.function.member");
assert.equal(semanticScope("entity.name.function"), "support.function");
assert.equal(semanticScope("entity.name.type.class.static"), "support.class.static");
assert.equal(semanticScope("entity.name.variable.readonly"), "variable.readonly");
assert.equal(semanticScope("operator"), "keyword.operator");
// Already-styled scopes and unknown ones are left alone.
assert.equal(semanticScope("keyword"), "keyword");
assert.equal(semanticScope("string"), "string");
assert.equal(semanticScope("variable.parameter"), "variable.parameter");
assert.equal(semanticScope("highlight_unnecessary"), "highlight_unnecessary");
assert.equal(semanticScope(undefined), "");

console.log("PASS  semantic token scopes map onto themed ace scopes");

// ...and the per-theme fallback for the scopes a theme still paints nothing for
// (ace-chrome, for one, has no working .ace_support.ace_class rule).
const semanticFallback = global.window.__ssExt._semanticFallback;

{
  // A theme that paints "support" and "variable" but nothing more specific:
  // every unpainted scope borrows from its nearest painted ancestor.
  const palette = { support: "#111", variable: "#222" };
  const rules = semanticFallback.rules("ace-x", (s) => palette[s] || null);
  const ruleFor = (scope) =>
    rules.find((r) => r.includes(`:where(.ace_${scope.split(".").join(".ace_")})`));
  assert.ok(ruleFor("support.class").endsWith("{ color: #111; }"));
  // ...but a theme that paints constant.library (what ace's lua mode gives `os`)
  // lends that to support.class ahead of the ancestor, so `sas` matches `os`.
  const green = semanticFallback.rules("ace-x", (s) =>
    s === "constant.library" ? "#0f0" : palette[s] || null,
  );
  assert.ok(
    green
      .find((r) => r.includes(":where(.ace_support.ace_class)"))
      .endsWith("{ color: #0f0; }"),
  );
  assert.ok(ruleFor("variable.other.property").endsWith("{ color: #222; }"));
  // No ancestor painted at all -> the generic donor, here "variable".
  assert.ok(ruleFor("typeParameter").endsWith("{ color: #222; }"));
  // Scopes the theme does paint get no rule, so the theme keeps winning.
  assert.equal(ruleFor("variable"), undefined);
  assert.match(rules[0], /^:where\(\.ace-x\) :where\(\./);
}
// A theme that paints nothing we can borrow from emits nothing at all.
assert.deepEqual(semanticFallback.rules("ace-y", () => null), []);

console.log("PASS  semantic token fallback colours per theme");

// ---------------------------------------------------------------------------
// src/emmylua-worker.js - message ordering into the Lua language server. A
// client may send a document's text as a didChange BEFORE its own didOpen (that
// is what ace-linters does when an editor's content lands between registering
// the session and the connection coming up), and the didOpen then carries the
// empty snapshot it took at registration. Left alone, the server ends up with
// an empty file and reports nothing until the next edit. The worker folds the
// held change's text into the didOpen instead.
//
// The wasm module is replaced by a stub that just records what it is handed, so
// this stays a pure-logic check.
const vm = require("vm");
const fs = require("fs");

function runWorker(defs) {
  const sent = [];
  const heap = new ArrayBuffer(1 << 16);
  let next = 8;
  const outbox = []; // messages the "server" wants to hand back, FIFO
  const exports = {
    memory: { buffer: heap },
    ela_alloc: (len) => {
      const ptr = next;
      next += len + 8;
      return ptr;
    },
    ela_push: (ptr, len) =>
      sent.push(JSON.parse(Buffer.from(new Uint8Array(heap, ptr, len)).toString("utf8"))),
    ela_start: () => {},
    ela_pump: () => {},
    // The worker's drain() loop: a pointer per queued message, 0 to stop.
    ela_take: () => {
      const msg = outbox.shift();
      if (!msg) return 0;
      const b = Buffer.from(JSON.stringify(msg), "utf8");
      const ptr = next;
      next += b.length + 8;
      new DataView(heap).setUint32(ptr, b.length, true);
      new Uint8Array(heap, ptr + 4, b.length).set(b);
      return ptr;
    },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    crypto: { getRandomValues: (a) => a },
    TextEncoder,
    TextDecoder,
    URL,
    setInterval: () => 0,
    setTimeout,
    fetch: async () => ({
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => defs,
    }),
    WebAssembly: {
      compileStreaming: () => Promise.reject(new Error("no streaming")),
      compile: async () => ({}),
      instantiate: async () => ({ exports }),
    },
  };
  sandbox.self = sandbox;
  sandbox.self.__ssExtEmmyLuaWasm = "file:///stub.wasm";
  if (defs) sandbox.self.__ssExtEmmyLuaDefs = "file:///stub-sas.lua";
  sandbox.self.postMessage = () => {};
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "emmylua-worker.js"), "utf8"),
    sandbox,
    { filename: "emmylua-worker.js" },
  );
  return { sandbox, sent, outbox };
}

(async () => {
  const { sandbox, sent } = runWorker();
  const post = (m) => sandbox.self.onmessage({ data: m });
  const uri = "file:///session1.lua";
  await new Promise((r) => setTimeout(r, 20)); // let the stub "wasm" resolve

  post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  // The text arrives as a change before the document was ever opened...
  post({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 1 }, contentChanges: [{ text: "print(1)\n" }] },
  });
  // ...and the open that follows carries the stale (empty) snapshot.
  post({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "lua", version: 1, text: "" } },
  });
  assert.deepEqual(
    sent.map((m) => m.method),
    ["initialize", "textDocument/didOpen"],
    "the early change must not reach the server on its own",
  );
  assert.equal(sent[1].params.textDocument.text, "print(1)\n", "didOpen carries the newer text");

  // Once open, changes pass straight through, untouched.
  post({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "print(2)\n" }] },
  });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].params.contentChanges[0].text, "print(2)\n");

  // A reopened document starts over (its held state was dropped on close).
  post({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
  post({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "lua", version: 3, text: "print(3)\n" } },
  });
  assert.equal(sent[4].params.textDocument.text, "print(3)\n");

  console.log("PASS  lua worker message ordering");

  // The SAS API definitions go in as one extra document, right behind the
  // initialize - the client never sees them and both consumers get them.
  const defsText = "---@meta\nsas = {}\n";
  const second = runWorker(defsText);
  await new Promise((r) => setTimeout(r, 20));
  second.sandbox.self.onmessage({ data: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.deepEqual(
    second.sent.map((m) => m.method),
    ["initialize", "textDocument/didOpen"],
    "the definitions are opened immediately after the initialize",
  );
  assert.equal(second.sent[1].params.textDocument.text, defsText);
  assert.match(second.sent[1].params.textDocument.uri, /sas\.lua$/);

  console.log("PASS  lua worker opens the sas definitions");

  // workspace/configuration is the server's only way to be configured here -
  // there is no .emmyrc.json to read - and the Lua version has to be answered,
  // or it assumes 5.4 while PROC LUA is tkLua 5.2.
  const third = runWorker();
  await new Promise((r) => setTimeout(r, 20));
  third.outbox.push(
    { jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [{ section: "emmylua" }, {}] } },
    { jsonrpc: "2.0", id: 8, method: "client/registerCapability", params: {} },
    { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.lua" } },
  );
  const posted = [];
  third.sandbox.self.postMessage = (m) => posted.push(m);
  third.sandbox.self.onmessage({ data: { jsonrpc: "2.0", id: 1, method: "initialize" } });

  // The server only ever READS config through a request, and only if the client
  // claims it can answer - which ace-linters never does.
  assert.equal(
    third.sent[0].params.capabilities.workspace.configuration,
    true,
    "the forwarded initialize claims workspace/configuration support",
  );

  const answers = third.sent.filter((m) => m.id === 7 || m.id === 8);
  assert.deepEqual(
    answers[0].result,
    [
      { runtime: { version: "Lua5.2" }, workspace: { workspaceRoots: [] } },
      { runtime: { version: "Lua5.2" }, workspace: { workspaceRoots: [] } },
    ],
    "every requested configuration item gets the config back",
  );
  assert.equal(answers[1].result, null, "other server-to-client requests are still answered null");
  assert.deepEqual(
    posted.map((m) => m.method),
    ["textDocument/publishDiagnostics"],
    "only notifications reach the client",
  );

  // ace-linters cannot do PULL diagnostics (its LanguageClient answers [] and
  // its ServiceManager posts that as every open document's diagnostics), so the
  // capability that makes it try is dropped from the initialize result.
  posted.length = 0;
  third.outbox.push({
    jsonrpc: "2.0",
    id: 1,
    result: { capabilities: { diagnosticProvider: { identifier: "EmmyLua" }, hoverProvider: true } },
  });
  third.sandbox.self.onmessage({ data: { jsonrpc: "2.0", method: "$/noop" } });
  assert.deepEqual(
    posted[0].result.capabilities,
    { hoverProvider: true },
    "the pull-diagnostics capability is stripped, everything else survives",
  );

  console.log("PASS  lua worker answers the server's configuration request");

  // A document's folder becomes a workspace root, pushed with
  // didChangeConfiguration - that is what gives the server a module name for it,
  // so a require() of another open .lua tab resolves.
  const fourth = runWorker();
  await new Promise((r) => setTimeout(r, 20));
  const post4 = (m) => fourth.sandbox.self.onmessage({ data: m });
  const open4 = (uri) =>
    post4({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "lua", version: 1, text: "" } },
    });

  post4({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  open4("file:///folders/myfolders/main.lua");
  open4("file:///folders/myfolders/helper.lua"); // same folder - no second push
  open4("file:///folders/other/mod.lua");

  const pushes = fourth.sent.filter((m) => m.method === "workspace/didChangeConfiguration");
  assert.deepEqual(
    pushes.map((m) => m.params.settings.workspace.workspaceRoots),
    [["/folders/myfolders"], ["/folders/myfolders", "/folders/other"]],
    "one push per new folder, roots accumulating",
  );
  assert.equal(pushes[0].params.settings.runtime.version, "Lua5.2", "the rest of the config rides along");

  // Our own definitions document must not become a root.
  fourth.sent.length = 0;
  open4("file:///ssext/defs/sas.lua");
  assert.deepEqual(
    fourth.sent.filter((m) => m.method === "workspace/didChangeConfiguration"),
    [],
    "the bundled definitions are not a workspace",
  );

  console.log("PASS  lua worker derives workspace roots from open documents");
})();

// ---------------------------------------------------------------------------
// src/editor-swap.js - user snippets, one set per ace snippet SCOPE. The whole
// of the logic is register/unregister bookkeeping against ace's snippetManager,
// so a stand-in for it is enough.
(function () {
  const ssExt = global.window.__ssExt;
  const registered = {}; // scope -> parsed set currently registered
  const sm = {
    parseSnippetFile: (text) => ({ text }),
    register: (parsed, scope) => {
      assert.ok(!registered[scope], "double register for " + scope);
      registered[scope] = parsed;
    },
    unregister: (parsed, scope) => {
      assert.equal(registered[scope], parsed, "unregister of what was registered");
      delete registered[scope];
    },
  };
  const scopes = () => Object.keys(registered).sort();

  ssExt.newLib = { ace: { require: (id) => (id === "ace/snippets" ? { snippetManager: sm } : {}) } };

  // Nothing to apply against until the ace lib is loaded.
  ssExt.applySnippets({ sas: "a" });
  assert.deepEqual(scopes(), []);
  ssExt.newAceLoaded = true;

  ssExt.applySnippets({ sas: "a", lua: "b", text: "" }); // an empty language registers nothing
  assert.deepEqual(scopes(), ["lua", "sas"]);
  assert.equal(registered.sas.text, "a");

  // Re-applying replaces every scope's set (no leak, no double register), and a
  // language dropped from the map is unregistered.
  ssExt.applySnippets({ sas: "a2", saslog: "c" });
  assert.deepEqual(scopes(), ["sas", "saslog"]);
  assert.equal(registered.sas.text, "a2");

  // Nothing seeded yet (ssExt.userSnippets' own default) unregisters the lot.
  ssExt.applySnippets({});
  assert.deepEqual(scopes(), []);
  assert.deepEqual(ssExt.userSnippets, {});

  console.log("PASS  per-language user snippets");
})();
