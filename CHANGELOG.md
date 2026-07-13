# Changelog

## 0.8

- Browse_ss/command palette history moves from page `localStorage` to
  `chrome.storage.local`, relayed through `window.postMessage` <-> `relay.js`
  (with a MAIN-world cache), so it survives "clear site data". Browse history
  keys are per-host namespaced (`browseSs:<host>:<name>`) to keep servers
  isolated; old `localStorage` data is migrated on first read. Palette
  history stays global by design.

## 0.7

- Keep focus in the editor after saving a code file (`keepFocusAfterSave`
  patch, on by default). A regular save fires `DMSEditor.successfulSave` →
  `projects.onRefresh`, which destroys and recreates the file tree; the new
  tree's `focusNode` then steals focus from the editor. The patch re-focuses
  the saved editor once `onRefresh` resolves — without `gotoLine`, so the
  cursor stays put (unlike SAS Studio's own commented-out SASSTUDIO-13593 fix,
  which reset the cursor to line 1). Gated on the exact refresh condition
  `successfulSave` uses, so autosave and Save As never trigger a stray
  refocus; works for both the stock editor and the Ace adapter.

## 0.6

- Save As at path (`saveFileAtPath` action / `:w <path>`): await the destination
  tree's load before expanding it. The Save As dialog rebuilds the tree on every
  open and sets its `rootNode` async, so on the 3.82 prod instance `_expandNode`
  could fire before `rootNode` existed and throw; warm trees skip the wait.
- Removed the two scroll-tree-to-input-path / scroll-tree-to-current-tab actions
  (browse_ss covers the same navigation) and the now-unused `resolveTablePath`
  helper. The surviving `scrollDestinationTreeToProjectSelectedNode` action moved
  off its default `Ctrl+Alt+F5` hotkey (swallowed by Linux as a VT switch, so it
  never fired) to `Alt+F6`, and now guards against an empty selection.
- Command palette / browse_ss now keep keyboard focus when a SAS Studio
  dijit dialog (e.g. Save As) opens over them. dijit's `show()` autofocus and
  the `focus.watch("curNode")` trap (which yanks focus back inside the top
  dialog whenever it leaves) are both suppressed while an SS-Ext prompt
  (`.ace_prompt_container` / `.ace_browse_ss_container`) is open — previously
  opening Save As over the palette would instantly steal focus to the dialog's
  first field, freezing the palette.
- Browse prompts: long truncated paths now reveal their tail two ways — the
  focused row's caption auto-scrolls (a linear ~100px/s slide to the end,
  snapping back when focus moves on; refiltering while typing jumps straight
  to the end instead of replaying the animation), and hovering any row shows
  the full value in a native tooltip (ace's `pointer-events:none` layer CSS,
  a Safari workaround irrelevant in a Chromium extension, is overridden for
  this popup's rows — without that the tooltips never show).
- Command palette: the 5 most recently run commands lead the list in MRU
  order (deduped — moved up, not repeated), so the last-run command is the
  pre-selected first row on reopen; per-server localStorage, and editor-only
  commands from the history never show in the global (unfocused) palette.
- Browse prompts (files/library; the tab browser has neither): bookmarks
  (`Ctrl+B` toggles on the selected entry — Ctrl on mac too, Alt+B is flaky
  there — stored per-server in localStorage next to the history, preserving
  the current selection instead of jumping back to the top) and a recent-items
  history are shown (tagged `⭐ Bookmark` / `Recent` on the first item of each category only; items below inherit the label by position, stripped of
  size/modified-time metadata) when the prompt is empty (`Ctrl+L` clears it —
  the full list) and, filtered by what you've typed, whenever the typed text
  doesn't point into the loaded folder (type a path fragment to jump to a
  saved item). Previously history only rendered when the typed path wasn't
  loaded, a state the library browser (which opens pre-filled with `libraries/`)
  never hit, so its recorded history was invisible. Directory listings now show
  an inline `⭐` next to any bookmarked entry. A dim placeholder hint (the keybinding legend)
  appears in the same empty-prompt state instead of always being shown.

## 0.5

- Options page now documents the custom vim ex-commands (`:w` save,
  `:w <path>` save-as, `:q` close tab, `:wq` save & close, `:x` run) as a
  static note in the Vim config section.
- LSP line limit (`aceConfig.lspMaxLines`, default 500, 0 = no limit): skips SAS
  language server registration for files longer than N lines, re-checked on
  `setText` since the code editor's real content arrives after construction.
  Configurable in the options page next to the existing "SAS language server"
  checkbox.
- Auto-minimized run-progress dialog (`minimizeBusyDialog` patch, on by
  default, checkbox in the options page - unchecked leaves SAS Studio
  untouched): the run-progress dialog is minimized to the bottom-right corner
  the moment a program starts, so the app stays usable while it runs (other
  busy dialogs keep their stock modal behavior). Refuses to start a second foreground run while one is in
  progress (`DMSEditor.prototype.submitHandler`/`interactiveSubmitHandler`
  guarded on `appDMS.dialogs.busyDialog`, plus every open tab's Run button
  disabled while minimized — that's what blocks Run/F3 in pre-existing tabs,
  whose handlers were hitched to the original function — and re-enabled at run
  end). Background submits stay allowed (separate SAS sessions). Session-bound
  requests (file open/save, dir listings) fired during a run are queued by the
  server until the run ends; a status note now says so, so an empty new tab
  reads as "waiting", not "broken". Notices use an ss-ext top-left in-page
  element (yellow for the run-refusal warning), sticky until the run ends or
  clicked away - SAS Studio's own toaster truncates longer messages.
  Opening a file as text (TXT/LOG/LST) during a run is refused with a notice:
  SAS Studio's text-view path posts an uncancelable "Reading file" modal that
  would hang the whole app behind the queued read until the run ends.
- Text viewer: closing a dirty (edited) text-viewer tab now prompts for
  confirmation, matching the code editor's behavior.

## 0.4

- SAS language server integration (Phase 4): `ace/mode/sas` editors get LSP-backed
  completions, hover, diagnostics, and semantic highlighting via `ace-linters` and
  the SAS language server (sassoftware/vscode-sas-extension) running in a web
  worker, loaded through a blob-URL `importScripts` worker. On by default
  (`aceConfig.lsp`, toggle in the options page); additive-only — no server bundle
  built (`./build_lib.sh`) or a worker failure just logs a warning and
  leaves the editor working as before. mode-sas.js gained embedded Python/Lua
  highlighting for `PROC PYTHON`/`PROC LUA` `submit;...endsubmit;` blocks.
- `lib/` is now gitignored, generated output. `./build_lib.sh` is the single place
  third-party library versions (ace-builds, ace-linters, the SAS language server)
  are recorded and rebuilt; `package.sh` runs it automatically if `lib/` is
  incomplete.

## 0.3

- New file action (Alt+N / command palette): create a new SAS program, same as F4.
- Save file at path action (Alt+Shift+S / command palette): drives SAS Studio's own
  Save As dialog from a typed absolute path (destination tree + filename), then
  confirms it, so tab rename/dirty-clearing/uri update all go through SAS Studio's
  own code.
- Editor: pick the Ace syntax mode from the file's extension instead of always
  defaulting to SAS.

## 0.2

- In-page hotkeys for editor/native-mouse toggles, badge bridge, browser-command cleanup.
- Re-vendored pristine ace 1.43.3; fork changes reproduced at runtime (`src/ace-patches.js`).
- Popup: show the SAS Studio auth cookies (path `/SASStudio`, httpOnly) with a copy button.

## 0.1

Initial release, growing a Tampermonkey userscript (floating Ace container) into
a full Manifest V3 extension that monkey-patches SAS Studio in the page's MAIN world.

- **Editor swap**: replace SAS Studio's built-in editor with Ace at runtime, toggled
  repeatably with no page refresh (`AceEditorAdapter` reimplementing the `SAS.Editor`
  API). Originally a draggable/resizable floating container synced to the host page;
  later reworked to swap the editor in place (`SAS.Editor`/`DMSEditor.createCodeEditor`
  dispatcher patch) instead.
- **SAS language support**: custom Ace mode (`mode-sas.js`) and snippets
  (`snippets-sas.js`), dark/light theme following system preference, persisted editor
  config (theme pair, Ace options, vimrc) applied live and on load.
- **Command palette & browse_ss**: `ext-browse_ss.js` extension for browsing/opening
  files, library items, and open tabs from a prompt UI (icons, children counts, start
  path from current tab, filterable history); later rebuilt on Ace's stock
  `ext/prompt` module with a global hotkey and per-editor command list.
- **Text viewer**: read-only Ace overlay over "View file as text", made editable with
  dirty-tab marking, save (toolbar button, Ctrl/Cmd+S, vim `:w`/`:wq`/`:x`).
- **~25 SAS Studio UX fixes** absorbed from the standalone userscript into the
  extension (nothing to install separately anymore): tab management, tree navigation,
  keyboard shortcuts, clipboard, context menus, middle-click/auxclick tab close,
  native-mouse-handling toggle, keep-alive, etc.
- **Configuration UI**: popup (editor toggle, native-mouse toggle, command palette
  button) and options page (per-patch checkboxes, rebindable hotkey table, editor
  theme/vimrc settings, custom snippet editor).
- Repo reorganized around a stable extension layout: source under `src/`, vendored
  Ace kept byte-identical to upstream under `lib/`, `package.sh` to build the
  publishable zip.
