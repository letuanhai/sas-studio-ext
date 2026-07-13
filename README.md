# SS Ext

A browser extension that toggles SAS Studio 3.8's built-in editor for a modern Ace
editor at runtime (SAS syntax highlighting, configurable snippets), plus various
independent UX fixes for the rest of SAS Studio.

## Features

- Toggle on/off with **Ctrl+.** (rebindable in the options page) or the popup's
  toggle button — no page refresh needed either direction; the toolbar badge
  updates either way
- Toolbar badge shows `ON` while Ace is active for that tab
- SAS syntax highlighting (`ace/mode/sas`, including embedded Python/Lua
  highlighting inside `PROC PYTHON`/`PROC LUA` `submit;…endsubmit;` blocks) and
  snippets, user-configurable from the options page
- Optional SAS language server: LSP-backed completions, hover docs, diagnostics,
  and semantic highlighting while Ace is active (see the section below —
  requires a one-time local build of the server bundle)
- Applies to every open tab and to new tabs opened while active
- Text, cursor position, and dirty (`*`) state are preserved across a toggle;
  undo history is not (see Known Limitations)
- Various UX fixes/quick actions (tab management, tree navigation, keyboard shortcuts,
  clipboard, context menus) — quick actions live in the command palette, on/off
  toggles and hotkey rebinding live in the options page
- Command palette (popup button, or global hotkey **Alt+Shift+P** — rebindable in
  the options page like any other action) works even with no Ace editor focused:
  it lists every `SS-Ext: ...` action plus, if an Ace editor (code or text
  viewer) was focused when it opened, that editor's own commands applied to it
- While Ace is active, "View file as text" opens in an editable Ace editor that
  mirrors the underlying (hidden) SimpleTextarea so SAS Studio's own load/refresh
  code keeps working. Editing marks the tab dirty (`*` in the title, like the code
  editor); save with the Save button next to Refresh, `Ctrl/Cmd+S`, or vim `:w` —
  Save POSTs to the workspace endpoint. Vim `:q`/`:wq`/`:x` close (and save) the tab
- Persistent editor configuration: Ace's own stock settings menu (`Ctrl-,`/
  `Cmd-,`, or "Show settings menu" in the command palette when an editor is
  focused — no custom preferences panel) is the settings UI. Any option changed
  there (font size, tab size, soft wrap, keyboard handler, ...) becomes the
  default for every new editor and live-applies to open ones; the theme knob is
  ignored (see below). The options page configures the dark/light theme pair
  and a small vimrc (`map`/`noremap`/`unmap` and their n/i/v variants) for the
  Vim keyboard handler, and both flow into the same shared config

## Editor configuration

`chrome.storage.local.aceConfig` (`{ darkTheme, lightTheme, options: { ... },
vimrc }`, default in `defaults.js`'s `DEFAULT_ACE_CONFIG`) is the single source
of truth for every Ace editor's defaults — the SAS Studio code editor, the
text-viewer overlay, and the options page's snippet editor. It flows two ways:

- **Stock settings menu → storage → everywhere else**: MAIN-world code can't
  touch `chrome.storage`, so a prototype-level hook on the settings menu's
  `OptionPanel.setOption` (patched once, after the original runs)
  `window.postMessage`s the updated config; `relay.js` (an ISOLATED-world
  content script) is the only thing listening and persists it. `sw.js`'s
  `storage.onChanged` listener then pushes the merged config to every open SAS
  Studio tab (`window.__ssExt.applyAceConfig`) and options.html picks it up
  too. The options page's snippet editor gets the identical hook, writing
  straight to storage instead.
- **Options page → storage → SAS Studio tabs**: the dark/light theme pair and
  vim config write straight to storage; the same `sw.js` listener pushes them
  out.

Theme is the one exception: it's always a `darkTheme`/`lightTheme` pair chosen
from the options page (auto-switched by OS `prefers-color-scheme`, matching the
existing behavior) — the panel's single "theme" option can't express a pair, so
a theme change made there is deliberately not persisted.

### Vim config

`aceConfig.vimrc` is a small subset of vim config, applied to the shared
`ace/keyboard/vim` module (only takes effect once Vim is the active keyboard
handler): one mapping per line, `"` starts a comment, blank lines are skipped.
Supported: `map`/`nmap`/`imap`/`vmap <lhs> <rhs>`, the `noremap` variants
(non-recursive), and `unmap`/`nunmap`/`iunmap`/`vunmap <lhs>`. Anything else is
skipped with a console warning. Removing a line doesn't undo that mapping until
the page is reloaded.

## Installation

1. Clone this repository
2. `./build_lib.sh` — generates the gitignored `lib/` directory (vendored Ace +
   ace-linters from npm, and the SAS language server bundle built from source;
   needs git/node/npm/network, the LSP build takes a while the first time)
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select this directory
4. (optional) Pin the extension from the puzzle-piece menu

## Usage

1. Open SAS Studio and let it fully load
2. Press **Ctrl+.** (or open the popup via the extension icon and click "Toggle
   Ace editor") to toggle Ace on
3. Press **Ctrl+.** again (or use the popup) to switch back to the original editor
4. Use the popup's "Command palette…" button (or **Alt+Shift+P** directly) for
   quick actions (reload file, focus tree, close tab, ...) and, when an Ace
   editor is focused, that editor's own commands; use the options page (link in
   the popup, or right-click the icon → Options) to turn UX patches on/off,
   rebind hotkeys, or edit custom snippets

## How It Works

`sw.js` pre-injects `editor-swap.js` into the page's MAIN world on every SAS
Studio page load (idempotent) and seeds it with the Ace library path, snippets,
and editor config. The **Ctrl+.** hotkey and the popup's toggle button both end
up calling `window.__ssExt.toggle(libPath)`:

- **First load** fetches the newer Ace library from `lib/ace/src-noconflict/`
  (`ace.js`, `mode-python.js`/`mode-lua.js` for the embedded highlighting,
  `ext-language_tools.js`, `ext-browse_ss.js`, `ext-prompt.js`,
  `ext-statusbar.js`, `ext-settings_menu.js`) and backs up a
  reference to the app's original bundled Ace so `window.ace` can be swapped
  back later. The new library's CSS stays attached permanently once loaded —
  SAS Studio renders its own editor DOM and never references any Ace CSS
  class, so neither build's stylesheet actually matters. This load can happen
  without activating anything (see Browsing, below).
- **Activating** swaps the `window.ace` global to the new library (it's still
  needed as the registry runtime `ace.require(...)` calls resolve tokenization
  against), installs one-time dispatcher patches on `SAS.Editor` and
  `DMSEditor.prototype.createCodeEditor` (so both existing and future tabs route
  to the right editor based on current state), then converts every open tab's
  editor to an `AceEditorAdapter`, re-binding `textChanged`/`selectionChanged`/
  `caretMoved`.
- **Deactivating** swaps `window.ace` back, captures each Ace tab's text,
  cursor, and dirty state, destroys the Ace instance, and recreates the original
  editor via the (now-dispatched) `createCodeEditor`, restoring what it captured.

## Browsing

The file/library/tab browsers are `ss-fixes.js` actions (`browseFiles` /
`browseLibrary` / `browseTabs`, default **Alt+P** / **Alt+O** / **Alt+T**) —
rebindable in the options page like any other action, and listed as
`SS-Ext: Browse …` entries in the command palette.

Once a browse prompt is open, these keys act on the selected entry (a compact
placeholder legend is also shown under the prompt while it's empty):

| Key | Action |
|-----|--------|
| `Enter` | Open the selected item (file / table / tab) |
| `Ctrl+Enter` | Open the selected file as text |
| `Shift+Enter` | Reveal the selected item in the tree |
| `Tab` | Fill the prompt with the selected item's name |
| `Shift+Space` | Go to the parent directory |
| `Ctrl+B` | Bookmark / un-bookmark the selected item (files/library only) |
| `Ctrl+L` | Clear the prompt |
| `Esc` | Drop the last path segment; close when already empty / at a folder |
| `Shift+Esc` | Close the prompt |
| `Alt+C` | Copy the item's name |
| `Alt+Ctrl+C` | Copy the item's full path |
| `↑` `↓` `PgUp` `PgDn` `Ctrl+↑`/`Home` `Ctrl+↓`/`End` | Move the selection |

The file and library browsers keep per-server (localStorage) bookmarks and a
recent-items history, tagged `⭐ Bookmark` / `Recent` on the first item of each category (items below inherit the label by position) and shown without
size/modified-time metadata. They appear when the prompt is empty (`Ctrl+L`
clears it) — the full saved list — and whenever what you've typed doesn't point
into the currently-loaded folder, in which case the saved list is **filtered**
by what you typed (so you can jump to a bookmark/recent by typing a fragment of
its path). While you're browsing inside a loaded folder, the listing is that
folder's contents instead, with an inline `⭐` marker on any entry that's
bookmarked. Accepting any entry records it in the history; `Ctrl+B` (Ctrl on
mac too — Alt+B is flaky there) pins/unpins the selected entry as a bookmark
without losing your place in the list. The tab browser has neither (open tabs
are already the whole list).

Long paths truncate on the right of the box; the selected row's text
auto-scrolls to reveal the hidden tail (and snaps back when you move on), and
hovering any row shows its full value in a tooltip.

Under the hood, `window.__ssExt.browse(kind, libPath, snippetsText)` only loads
the new Ace library if needed — it does not activate the editor replacement, so
browse prompts work even while the built-in editor is still in use.

## UX fixes and configuration

`ss-fixes.js` (injected automatically on every SAS Studio page load) provides
various independent fixes on top of the editor toggle: tab management, tree
navigation, keyboard shortcuts, clipboard, context menus. Quick actions
(reload file, close tab, focus tree, ...) live in the command palette
(Alt+Shift+P), each with its default hotkey shown alongside. Passive patches (confirm-on-drop,
middle-click-close, keep-alive, ...) and hotkey bindings are configured from
the options page (`chrome.runtime.openOptionsPage()`, linked from the popup) —
patch/hotkey changes apply on the next page reload.

## Snippets

The options page also hosts an Ace-editor-backed snippet editor
(`chrome.storage.local.snippets.sas`, native Ace snippet format). Saved
snippets are additive over ace's own built-in SAS snippets and live-apply to
every open SAS Studio tab immediately (no reload needed) via a
`chrome.storage.onChanged` listener in `sw.js`.

## Known Limitations

- Only tested with SAS Studio 3.82
- Undo/redo history does not survive a toggle in either direction
- `getHTML()` (used by print/summary views) returns plain escaped text rather
  than syntax-highlighted markup — Ace has no built-in HTML export loaded
- Some advanced context-menu customization is limited
- Duplicate snippet triggers (built-in vs. user-defined) both appear in the
  completion list rather than the user one taking priority

## Files

The repo root is the extension root (the directory you load unpacked):
`manifest.json` at the root, source files under `src/`, `assets/` and `lib/`
at the root. `lib/` is gitignored, generated output: `./build_lib.sh` is the
single place third-party library versions are recorded and bumped — it vendors
`ace-builds` and `ace-linters` from npm (byte-identical to the tarballs) and
builds the SAS language server bundle from source. `./package.sh` zips
`manifest.json src assets lib` (plus README/LICENSE/CHANGELOG) into
`dist/sas-studio-ext-<version>.zip` for publishing, running `./build_lib.sh`
first if `lib/` is incomplete, and leaving out everything development-only
(reference docs, `test/`, extracted app source). Within the runtime tree:

- `manifest.json`, `src/sw.js` — extension config + service worker (editor toggle,
  ss-fixes injection, live snippet apply, live ace-config apply)
- `relay.js` — ISOLATED-world content script; the only bridge from the
  in-page settings panel (MAIN world) to `chrome.storage.local.aceConfig`
- `editor-swap.js` — `AceEditorAdapter`, the `window.__ssExt` singleton, the
  one-time SAS.Editor/DMSEditor patches, and the settings-menu persistence hook
- `ss-fixes.js` — various UX fixes, split into one-shot `ACTIONS` and passive `PATCHES`
- `tools-meta.js` — shared `SSF_TOOLS` metadata (labels/titles/hotkeys) for
  ss-fixes, the popup, and the options page
- `defaults.js` — shared `DEFAULT_SAS_SNIPPETS`/`DEFAULT_ACE_CONFIG` defaults
- `popup.html`/`popup.js` — editor toggle, native-mouse toggle, command palette button
- `options.html`/`options.js` — patch toggles, hotkey rebinding, editor config
  (theme pair, vim config), snippet editor
- `lib/ace/` — pristine upstream `ace-builds` 1.43.3 (byte-identical to the npm
  package; generated by `./build_lib.sh`, don't hand-edit anything under here).
  The command palette is built
  on the stock `ext-prompt.js` module, and the settings menu is the stock
  `ext-settings_menu.js` module (bundles its own `OptionPanel`, `overlayPage`,
  and `themelist`) — neither is custom.
- `src/ace-patches.js` — reproduces at runtime the author's ace-fork source
  changes (github.com/letuanhai/ace) so `lib/ace/` stays pristine: a theme-aware
  scrollbar cursor + selection-range bars (`decorators`), vim-aware Esc
  passthrough (`autocomplete`/`snippets`), a SAS `modelist` entry, and the
  fork's 1-based `statusbar` format (the code editor shows a status bar overlay)
- `src/ace-seed.js` — one-liner that applies the ace-patches on the options
  page, ordered before the settings menu so its Mode list includes SAS
- `src/ace/` — the custom (non-upstream) Ace files: `mode-sas.js`,
  `snippets-sas.js`, `ext-browse_ss.js` (+ its `.d.ts`)
- `lib/ace-linters/` — pristine upstream `ace-linters` 2.2.0 UMD builds
  (`language-client.js`, `ace-language-client.js`) — the SAS language server
  client; only 2 of the package's ~26 build files, the ones needed to drive an
  external LSP server over a web worker
- `lib/sas-lsp/` — `sas-server.js`, the ~22 MB SAS language server browser
  bundle, built by `./build_lib.sh` from a pinned release tag of
  sassoftware/vscode-sas-extension with the embedded Pyright stripped
  (`remove-pyright.patch` at the repo root); the extension works fine without
  it, just without LSP features
- `SAS_EDITOR_API.md`, `sas-editor.d.ts`, `EDITOR_USAGE_MAP.md` — reference docs
  for the `SAS.Editor` API surface `AceEditorAdapter` implements

## SAS language server (optional)

While Ace is active, `ace/mode/sas` editors (the code editor and a `.sas` text
viewer) get real LSP-backed completions, hover docs, diagnostics, and semantic
highlighting, via [ace-linters](https://github.com/mkslanc/ace-linters) and the
SAS language server (sassoftware/vscode-sas-extension) running in a web worker.
On by default (options page checkbox, "applies next time the Ace editor is
activated"). The ~22 MB server bundle is generated by `./build_lib.sh`, not
committed; without it the extension logs one console warning and works exactly
as before. The
build strips the server's embedded Pyright (Python LSP, ~6 MB) — `PROC PYTHON`
gets no LSP features, but the SAS mode's embedded Python/Lua highlighting
covers readability.

## Development

No build step for the extension's own code (only `./build_lib.sh` for the
gitignored `lib/`, and no Tampermonkey). To test changes manually: reload the unpacked
extension in `chrome://extensions/`, refresh the SAS Studio page, and toggle
from the popup. `node test/smoke.js` runs the end-to-end smoke test — headless
Chromium with the unpacked extension against a live SAS Studio instance,
exercising injection, tab management, the editor toggle, the text viewer, the
command palette, editor config, and LSP startup (see the file header for
`SS_URL`/`CHROME_BIN` env vars and the playwright requirement). To bump a
vendored library version, edit the version variable at the top of
`./build_lib.sh` and re-run it. Logs are prefixed
`[SS Ext]` — one line per toggle (`activated`/`deactivated ... N tab(s) ...`),
plus errors and warnings for unexpected states.

## Credits

- **SAS Studio** — original application
- **Ace Editor** — the code editor library ([ace.c9.io](https://ace.c9.io))

---

**Note**: This is a reverse engineering project for educational and personal use. Use at your own risk.
