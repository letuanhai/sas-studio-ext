# Custom Ace code — `src/ace-patches.js` and `src/ace/`

`lib/ace/` is a generated, pristine-plus-namespace build (see [development.md](development.md)).
**Nothing under it is ever hand-edited**: runtime tweaks go in `src/ace-patches.js`, build-level changes in
`tools/ace-namespace.patch`.

## `src/ace-patches.js`

`window.__ssExtApplyAcePatches(ace)`, called once per loaded `ace` instance, reproduces at runtime the source
modifications from the author's ace fork (github.com/letuanhai/ace — commits by letuanhai only, determined by diffing
that fork's commits, not by diffing the built output against upstream).
Each patch is independently try/catch'd and idempotency-guarded.

1. `ace/layer/decorators` — `$updateDecorators` fully replaced (pristine 1.43.3 body + the fork's two edits) so the
   scrollbar-overview cursor bar is theme-aware and every selection range is drawn as a half-width bar.
2. **vim-aware Esc** — `ace/autocomplete`'s `Autocomplete.prototype.commands.Esc` and `ace/snippets`' (unexported)
   `TabstopManager.prototype.keyboardHandler`'s Esc both forward to the vim keyboard handler after detaching, only when
   vim is the active handler.
   `TabstopManager` isn't exported, so this grabs its prototype via a throwaway editor + snippet insertion;
   both modules live in `ext-language_tools`, so on pages that don't load it (the options page) the patch skips
   silently.
3. `ace/ext/modelist` gets a SAS entry pushed onto it (`Mode` isn't exported, so this clones an existing instance's
   prototype instead of `new Mode(...)`), and its `log` entry is retargeted at `ace/mode/saslog` — modelist's own
   `ace/mode/log` has no file in this build and silently 404s.
   `ctm` is appended to the XML entry's extensions (SAS Studio task definitions are XML);
   its `extRe` is rebuilt off its own `source` rather than off `extensions`, so whatever prefix ace's `Mode`
   constructor put there survives.
4. `ace/ext/statusbar` — `StatusBar.prototype.updateStatus` fully replaced with the fork's
   `" Line r/total (n selected), Col c "` 1-based format (skipped when `ext-statusbar` isn't loaded).

**Not reproduced**: mouse/gutter/virtual_renderer/theme differences that showed up when diffing our old vendored build
against npm 1.43.3 — those were version drift between the fork's base ace and 1.43.3, not the author's modifications, so
they revert to pristine.

Call ordering is described in [editor-swap.md](editor-swap.md);
the options page does the same via `src/ace-seed.js`, a one-line `<script>` between `ext-modelist.js` and
`ext-settings_menu.js` — a file, not inline, because the extension CSP forbids inline scripts.

Both the MAIN-world adapter and the options-page snippet editor construct an `ace/ext/statusbar` `StatusBar` as a
non-intrusive bottom-right overlay (`pointer-events:none`), its font size tracking the configured `fontSize`.

## `src/ace/` — the custom (non-upstream) Ace modules

Listed under `web_accessible_resources` (`src/ace/*.js`), since these load via a page-injected `<script src>`, not
`chrome.scripting`.

### `mode-sas.js` / `snippets-sas.js`

The SAS mode, plus Ace's own Python/Lua highlight rules embedded inside `PROC PYTHON`/`PROC LUA` `submit;…endsubmit;`
blocks — which is why `loadNewAce()` loads `mode-python.js`/`mode-lua.js` before any editor or the SAS mode itself can.

### `mode-saslog.js`

`ace/mode/saslog`: the SAS mode plus one fold rule for the `NOTE: %INCLUDE (level n) file …` / `… ending.` blocks SAS
writes into a log.
SAS prints the nesting level itself, so the first counterpart at the SAME level is the match and no depth counting is
needed.
Its fold widgets on the CLOSING line only show up because `DEFAULT_ACE_CONFIG.options.foldStyle` is `"markbeginend"`;
that also turns on the end-of-block widgets the SAS fold mode has always supported (`run;`/`quit;`/`%mend`/`end`).

It also adds `ace/mode/saslog_highlight_rules`: the SAS rules plus **severity colours per LOG LINE** — one whole-line
token for a line starting `NOTE:`/`WARNING:`/`ERROR:`/`INFO:`/`DEBUG:` (SAS's numbered forms, `ERROR 22-322:`,
included).
Only lines with a severity marker receive severity colours;
indented continuation lines and other output keep ordinary SAS syntax highlighting.
The marker may be INDENTED — SAS emits indented ones — so what counts is that the line's first non-space text is the
marker, not that it starts at column 0.
Whole line rather than just the marker, because the useful fact is "this line is an error", which is also how SAS
Studio's own Log pane reads.

Matching is case-INSENSITIVE, deliberately: a hand-written `%put error: …` means the same severity as SAS's own
uppercase marker.
It started out that way by accident — ace compiles one regex per state with a flag shared by every rule in it — and the
rules now declare the flag themselves so it cannot silently flip with one that isn't ours.

**The token names (`saslog_error`, …) are deliberately NOT TextMate scopes**, and a small `importCssString` sheet in
that module is the only thing that paints them.
No ace theme has five severity scopes, and the nearest thing, `.ace_invalid`, is absent from BOTH configured defaults
and pink in dracula — the same "I picked a scope and nothing painted it" trap `SEMANTIC_SCOPE_ALIASES` exists for,
avoided this time by not depending on a theme at all.
The colours are SAS's own convention (NOTE blue, WARNING green, ERROR red — the Display Manager log), with INFO and
DEBUG, which have no colour there, reading as "extra information" and "noise".
Light/dark is one `.ace_dark .ace_saslog_*` override, i.e. the class the RENDERER puts on the container for a theme
whose `isDark` is set — so the colours follow the editor THEME, not the app's dark mode, which is the pair that has to
agree.

The marker rules are unshifted into EVERY state of the SAS rules, not just `start`: an unbalanced quote in an echoed
source line leaves the SAS rules inside a string state that otherwise runs to the end of the file, and a log is exactly
where that happens.
After consuming a marker line, `next: restart("start")` returns to ordinary highlighting and additionally clears the
tokenizer STACK — a separate and much smaller thing, mattering only for the embedded-language blocks the SAS rules push,
where a `NOTE:` inside one would otherwise carry that block's stack to the end of the file.
Highlighting is right either way, which is why that line needs a check of its own (the state after such a line being a
plain string rather than a stack).

Tests: `test/units.js` covers the %INCLUDE fold logic against a ~20-line stand-in for ace's module registry;
the colours need a real ace with a real theme, so they live in `test/options.js`.

### `ext-browse_ss.js` (+ `.d.ts`)

The custom file/library/tab-browsing prompt.
`window._browseSsLastPrompt` exposes the open prompt's `{ popup, cmdLine }` for debugging and smoke tests.

**History and bookmarks.** The files and library browsers keep history in `chrome.storage.local` (relayed via
`relay.js`, per-host-namespaced as `browseSs:<host>:<name>` since the storage is extension-global) plus `Ctrl+B`-toggled
bookmarks (key = `historyKey + 'Bookmarks'`;
`Ctrl+B` preserves the current row instead of resetting to the top).
They are shown — tagged `⭐ Bookmark`/`Recent` on the first item of each category only, items below inheriting the label
by position, size/modified-time metadata stripped — in two cases: the empty prompt (full list), and the "typed path's
folder isn't the loaded collection" branch, where `savedCompletions(cmdLineValue)` filters them fuzzily by what's typed
so you can jump to a saved item by typing a path fragment.
The tab browser deliberately has neither.

**Where a prompt opens.** Each browser reopens at the path it was closed on (module-level `lastPaths`, keyed by
`historyKey`, written in `done()` — in-memory, so a page reload falls back to `options.startPath`).
The TABS browser has no `historyKey` and so neither saves nor restores one:
it is an alt+tab list, and reopening onto the previous switch's filter text would hide the tab you just came from.
The empty prompt lists the focused tab's own item first (tagged `Current tab`;
the library one keeps `meta: '>'` so accepting it lists the table's columns) and `options.startPath` last (tagged
`Root`).
That start path is `getStartPath()`, which prefers `__ssExt.browsePaths.files`/`.library` (the popup's per-host
"Browse roots") and falls back to the built-in project-tree-root / `libraries/` behaviour when blank.
`lastPaths` entries record the root they were saved under (`{path, root}`), so a changed root supersedes the remembered
wandering point instead of being masked by it.

**Sorting.** `getFilteredCompletions` sorts ace's `filterCompletions` output (which scores but never sorts) so exact
name
matches rank first, then prefix matches, ties keeping collection order.
`savedCompletions` therefore filters bookmarks and history separately, so the sort can't interleave the two labelled
runs.
When the typed path IS the loaded folder, it's that folder's contents (no saved entries mixed in), with an inline `⭐` on
any bookmarked entry;
the keybinding-legend placeholder hint shows in the empty-prompt state only.

**The box** is the original fixed centered one (no drag/resize/footer).
Long paths truncate on the right, with two per-item tail reveals: the focused row's caption spans are wrapped into one
clipped box whose inner box is `translateX`-animated left to the end (~100px/s, re-applied on every renderer
`afterRender` since ace rebuilds row DOM each render — a same-row render whose wrap survived is left alone so the
in-flight animation isn't cancelled, while a same-row DOM rebuild, i.e. typing, jumps to the end without animating), and
every visible row gets a native `title` tooltip with its full value.
All rows, not just the focused one — ace recycles row nodes, so a focused-only title would go stale;
it needs the scoped `pointer-events:auto` rule because ace's `.ace_layer{pointer-events:none}` Safari workaround
otherwise keeps rows from ever being the hover target.

**`accept(mode)`** takes `text`/`reveal`/`download` (the `acceptAsText`/`revealInTree`/`acceptDownload` keys pass one
explicitly;
`download` sets `fileType: 'EXT'`, which `openItemInSs` turns into `FileOpenWithExternalProgram` → AppDMS types it `""`
→ `openOtherFileAction`, its hidden-iframe download — "open with external program" is SAS Studio's name for it, ours is
download, and only the calls into SAS keep the former).

A plain Enter passes none and looks the extension up in `__ssExt.browseFileActions`, falling back to `reveal` for
**anything unlisted**.
SAS Studio's own handling ends in that same hidden-iframe DOWNLOAD for every type it can't recognise, and no keystroke
should do that by accident.
The blanket reveal is deliberate rather than a would-this-download test: predicting SAS's chain per type is more fragile
than one rule, and the map plus `acceptDefault` ("Let SAS Studio decide", Ctrl+Shift+Enter, `mode: "open"`) cover the
cases worth opening — which is also why `open` had to exist as an action at all.
That lookup is gated on the prompt's `fileActions: true` option, i.e. the FILE browser only: a library item has no
extension and a tab called "x.lua" is a tab, not a file to reveal.

`pick_file(cb)` is the same browser with `openItem` swapped for a callback and `fileActions` off, used by
`diffAgainstFile`;
`onClose` (added to the prompt's `done()`) answers `null` for a dismissal.

`focusItemOnTree` returns early when nothing in the tree matched rather than throwing on the null node (a stale
bookmark, or a reveal of a path that no longer exists).
Items are opened through the same `item.id`-backfill rule `ss-fixes.js`'s `openItem` uses.

**Keybindings** are built by name from `SSF_BROWSE_KEYS` (an `actions` map of name→handler, keyed in through
`ssfBrowseKeys(tool, __ssExt.browseKeys)`), so every one is rebindable from the options page and applies to the next
prompt opened without a reload.
The placeholder hint line is generated from the same table (`legend` entries only), so it can't drift from what's
actually bound.
The two copy bindings go through `window.__ssf.copyTextWithNotice`, which is why they show the same notification as the
"Copy Path" actions and work on the insecure origin.
Its prompt/popup font size comes from the configured `fontSize` rather than the 14/15 it used to hardcode.

**The tabs browser as alt+tab.**
Its list comes from `__ssf.tabsByAccess()` (see [ss-fixes.md](ss-fixes.md)), i.e. most recently selected first with the
current tab last, so row 0 — the row `setData` leaves selected — is the previously used tab.

The alt+tab part is the `hold` option, and only the `browseTabs` HOTKEY sets it: that is the one entry point holding the
opening `KeyboardEvent`, which is where the modifiers to watch and the key to repeat come from (`{key, mods}`, recorded
by ss-fixes' `noteTabHold` and left on `window.__ssfTabHold` for `browse_tabs` to consume and clear).
`noteTabHold` also watches for those modifiers being RELEASED before the prompt is up: the first open of a page loads
the ace library first, which takes long enough that they usually are, and a hold prompt waiting for a keyup that already
happened would never jump.
Such an open falls back to an ordinary prompt.

While the hold lasts, two window listeners in the CAPTURE phase own the keyboard (ss-fixes' own hotkeys already stand
down while a prompt is open):

- the hotkey's own key with the modifiers still down steps the selection, `Shift` reversing it, wrapping by arithmetic
  rather than `popup.goTo` — ace's `goTo("down")` wraps through `-1` (no selection), which is a dead row in a list you
  are stepping around.
- a keyup of any of the required modifiers accepts the selected row.
  Only the RECORDED modifiers, so a binding without Shift can use Shift to step back.
  One with Shift in it can't, and jumps on its release instead.

Any other CHARACTER key means a search, which retires the jump-on-release for good (and with it the step key, or a
search could not contain one).
Those characters are inserted by hand and go on being inserted while the modifiers are down: the command line would
otherwise be receiving Alt+&lt;letter&gt;, which inserts nothing and may be an ace command.
Keys that produce no text are left to the prompt's own bindings, and a key pressed once the modifiers are gone is left
alone entirely — the command line handles it perfectly well, and taking it over would break its editing bindings
(Ctrl+V among them).
