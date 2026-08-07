/**
 * Pure-logic checks for the shared helpers in src/tools-meta.js - no browser,
 * no live SAS Studio instance: `node test/units.js`.
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
