# Changelog

## 0.14

- Removed remotely hosted code from the vendored libraries so the extension
  passes Chrome Web Store Manifest V3 review (which had rejected it). Ace's
  bundled html/liquid snippet files carried an `html5shiv` snippet whose body
  is a `<script src="https://cdnjs.cloudflare.com/...">` tag, and ace-linters
  pointed its (unused) python service at a script on unpkg.com. Both were inert
  here — neither snippet mode is reachable from a SAS editor and the language
  server runs from a worker we build ourselves — but the store scans shipped
  source as if it executed. The snippet files are now dropped and the unpkg URL
  blanked out at build time, each guarded so a future library bump fails loudly
  if the string comes back.

## 0.13

- Cancelling a run no longer means leaving maximized view first. The maximize
  patch collapses the bottom status bar, which is also where the minimized run
  dialog puts its Cancel link, so the link was unreachable for the whole run.
  The bar is now kept (or brought back) at its normal height while a run is in
  flight — including when you maximize mid-run — and collapses again at run
  end.
- Browse matches whose name actually contains what you typed now rank above
  fuzzy ones, which previously could push a plain substring hit below a
  scattered-letter match.

## 0.12

- The file and library browsers now reopen where you left them: the prompt
  resumes at the path it was closed on (in memory, so a page reload falls back
  to the root), and the focused tab's own file/table moved out of the prefilled
  input and into the empty prompt's list as its first entry, tagged "Current
  tab", above the bookmarks and recents. Every open used to jump away from
  wherever the last one ended up.
- The browsers' start paths ("Browse roots") are configurable, in the popup
  rather than the options page: they name folders on one specific server, so
  they are stored per host and the popup is already scoped to the active tab —
  no host to type, no way to give a second SAS Studio instance the wrong roots.
  Blank keeps the built-in project-tree-root / `libraries/` behavior. A change
  takes effect at the next browse prompt rather than the next page reload, and
  supersedes the remembered last path. The root is also listed last in the
  empty prompt, tagged "Root", so it is one keypress away.
- Browse matches are sorted by how well they match what you typed instead of by
  the folder's own order, so an exact name is the first row rather than
  wherever it happened to sit in the listing. Bookmarks and recents are sorted
  separately so the two labelled runs can't interleave.
- Opening a file as text from the browse prompt no longer hangs the app. The
  item it passed had no id, so the second such tab threw on a duplicate widget
  id and left the modal "Reading file" dialog up forever. Only the browse path
  was affected — tree items already carry an id.
- New "Force-close a stuck busy dialog" action (unbound by default, assignable
  in the options page, listed in the command palette). When SAS Studio errors
  with a busy or run dialog up, the modal never comes down and its underlay
  blocks the whole app; until now the only way out was reloading. It destroys
  the live dialogs, hides a leftover underlay, re-enables what the run-dialog
  patch disabled, and resets any tab still marked as running. Each step is
  guarded: it reports what it cleared, or says the app is usable but should be
  reloaded.
- Several default hotkeys were wrong and never fired: the tab-switching and
  layout-reset defaults named the shifted punctuation (`}`, `{`, `|`) instead
  of the physical key, and every letter default was uppercase, which no longer
  matches after the Alt-key handling added in 0.11. Two pairs also collided —
  "Open user input target" (now unbound) clashed with "Browse library" on
  Alt+O, and "Reopen closed tab" (now Alt+Shift+W) with "Browse tabs" on
  Alt+T. Hotkeys you set yourself are untouched.
- Our Ace and SAS Studio's own bundled 1.x Ace are now two separate libraries
  with separate module registries: `build_lib.sh` builds Ace from source with
  its registry renamed to `window.__ssAce`, so `window.ace` is never touched.
  Previously the extension replaced SAS's Ace outright — the only way to stop a
  lazily loaded module (`keybinding-vim.js` and anything like it) from landing
  in whichever library owned the global — which left SAS's stock editor running
  on our build and made every Ace upgrade a compatibility exercise. Nothing
  changes visibly; Ace upgrades stop being able to break the stock editor.

## 0.11

- New "Use the Ace editor from page load" patch in the options page: with it
  ticked, the Ace editor replacement activates by itself on every SAS Studio
  page load instead of needing the toggle each time (you can still toggle it
  back off with the hotkey or the popup). It is off by default — the first
  patch that starts disabled rather than enabled.
- Hotkeys using Alt/Option are recorded and matched by the physical key
  instead of the character the OS produces. On macOS, Option+n or Option+.
  composes a dead key or a symbol, so such a binding showed up as "Alt+Dead"
  or "Alt+≥" and never fired; it now reads and triggers as "Alt+n" / "Alt+.".
  The keyboard layout is read once on the options page via
  `navigator.keyboard.getLayoutMap()` and handed to the page from there — that
  API is unavailable on a plain-http SAS Studio page — with a US layout as the
  fallback until the options page has been opened once. Existing bindings keep
  working; matching is case-insensitive.
- Changing anything in the in-page Ace settings menu no longer wipes the saved
  vim keymap. The config object posted back to storage on every such change
  was built without its `vimrc` field, so e.g. switching the keyboard handler
  silently cleared it. The options-page section is now labelled "Vim Keymap".

## 0.10

- The `keepFocusAfterSave` patch is replaced by `noTreeFocusSteal` (settings
  label "Stop the file/libraries trees stealing focus"). The old patch only
  covered saves and raced the tree reload's timing; the new one wraps
  `dijit.Tree.prototype.focusNode` so it keeps its selection/tabIndex
  bookkeeping but skips the DOM focus whenever focus currently lives outside
  that tree. Trees still take focus when you click or arrow-key into them, or
  when an open dijit dialog places focus. Covers reloads after a run and after
  any file operation, not just saves.
- The vim normal-mode block cursor no longer disappears on some themes. Its
  `.normal-mode .ace_cursor` rule is a two-class selector, so a theme sheet
  loaded later at the same specificity wins — `theme-github_light_default`
  sets `background: none`, `theme-ambiance` drops the cursor layer behind the
  marker layer. Both are now overridden from our own sheet.
- Stylesheets injected by SAS Studio's own bundled (1.x) ace are dropped
  before the new ace loads. SAS uses that ace only as a tokenizer and
  references no `.ace_*` class, but ace's `importCssString` dedupes by
  `<style>` id, so any id SAS registered first silently discarded our version
  of it.
- New "Toggle maximized view" action (unbound by default — SAS Studio's own
  Alt+F11 already does it), available from the command palette and bindable
  like any other action.
- The options page now flags hotkeys bound to more than one action in red.
  Two actions on the same key silently race; saving is still allowed.

## 0.9

- Vim `:x` on a visual selection now submits only the selection: vim collapses
  the Ace selection before the ex handler runs, so the handler re-selects
  `params.line`/`lineEnd` before invoking `runCurrentProgram`.
- browse_ss caption rows use `white-space: pre` instead of `nowrap`, which was
  collapsing the trailing space after the item icon.

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
