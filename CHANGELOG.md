# Changelog


## 0.19

- Reopening a closed tab now works for tabs closed with the tab's own X button,
  not just those closed from the menu or with the middle mouse button.
- In dark mode the empty workspace (shown when no tab is open) stays dark
  instead of flipping to a light pane.

## 0.18

- The completion popup, the command palette and the browse prompts are
  resizable: drag the box's corner for the width, the list's for its height. A
  prompt's size is reused for the rest of the page session.
- The changelog is readable from the extension itself, on its own page linked
  from the options page's nav bar, and its entries are now short summaries
  rather than essays.

## 0.17

- Autocompletion offers words from your other open editors (tagged `tab`), not
  just the file you are typing in.
- Library and table names from the SAS language server actually appear now: the
  extension opts in to the server's library request and answers it from SAS
  Studio's own tree, re-reading it whenever SAS Studio refreshes the tree.
- Fixed two bugs that hid the language server's suggestions even when it
  answered — they sorted below hundreds of plain words, and every editor leaked
  a duplicate of the server's completer.
- New completion for the two things the SAS language server cannot answer:
  tables inside `proc sql;` and column names, both from the library tree.
- The completion popup says where each entry comes from — `library`,
  `SASHELP.` for a table, `CLASS.` for a column, `program` for a data set name
  parsed out of your code.
- The command palette, the file/library browser and Ace's settings panel follow
  dark mode, and use the configured editor font size instead of Ace's 12px.
- Moving several files at once by drag-and-drop asks once, not once per file,
  and lists everything that is about to move.

## 0.16

- The SAS language server no longer slows the editor down on large files or
  degrades the longer a page stays open: syntax-colouring markers are limited to
  the visible rows, reclaimed when discarded, and requested once per scroll.

## 0.15

- New dark mode for SAS Studio's own interface (Off / Always on / Follow system,
  in the options page), applied to open tabs immediately and in place before the
  page first paints. "Always on" switches Ace to its dark theme too.
- It ships as a pre-generated stylesheet, not a live theming engine: a
  general-purpose dark-mode extension re-parses ~95 stylesheets per load, drops
  icons when one is slow, and makes typing ~5x slower with the language server on.
- Fixed the file browser's copy shortcuts (`Alt+C` name, `Alt+Shift+C` path),
  which never worked: global hotkeys ate the key, and clipboard access is
  unavailable over plain http. All copying now works there, with a notification.
- Every key inside the file/library/tab browser is rebindable, in a new "Browse
  prompt keys" table in the options page; the prompt's hint line is generated
  from the same table, so it always shows what is actually bound.
- The options page has a sticky table of contents.

## 0.14

- Removed remotely hosted code from the vendored libraries (an Ace snippet with
  a cdnjs `<script>` tag, an unused unpkg URL in ace-linters) so the extension
  passes Chrome Web Store Manifest V3 review.

## 0.13

- Cancelling a run no longer requires leaving maximized view first: the status
  bar holding the Cancel link is kept at full height while a run is in flight.
- Browse matches whose name contains what you typed rank above fuzzy ones.

## 0.12

- The file and library browsers reopen where you left them, and the focused
  tab's own file/table is the first entry of the empty prompt.
- The browsers' start paths ("Browse roots") are configurable in the popup, per
  host — they name folders on one specific server, and the popup is already
  scoped to the active tab.
- Browse matches are sorted by how well they match what you typed, so an exact
  name is the first row rather than wherever it sat in the listing.
- Fixed opening a file as text from the browse prompt hanging the app on the
  second such tab (the item it passed carried no id).
- New "Force-close a stuck busy dialog" action for when SAS Studio errors with a
  modal up, which used to mean reloading the page. Unbound by default.
- Fixed several default hotkeys that never fired (shifted punctuation, uppercase
  letters) and two pairs that collided. Hotkeys you set yourself are untouched.
- Our Ace and SAS Studio's own bundled Ace are now separate libraries with
  separate module registries, so `window.ace` is never touched and an Ace
  upgrade can no longer break the stock editor.

## 0.11

- New "Use the Ace editor from page load" patch (off by default): the editor
  replacement activates by itself on every SAS Studio page load.
- Hotkeys using Alt/Option are recorded and matched by the physical key, so
  macOS bindings like Option+n no longer register as "Alt+Dead" and never fire.
- Fixed the in-page Ace settings menu wiping the saved vim keymap on every
  change.

## 0.10

- `keepFocusAfterSave` is replaced by `noTreeFocusSteal`, which stops the
  file/libraries trees taking focus on any reload rather than only after saves.
- The vim normal-mode block cursor no longer disappears on themes whose sheet
  loads after the vim keybinding's.
- Stylesheets injected by SAS Studio's own bundled Ace are dropped before ours
  loads — matching ids silently discarded our version.
- New "Toggle maximized view" action (unbound by default).
- The options page flags hotkeys bound to more than one action in red.

## 0.9

- Vim `:x` on a visual selection submits only the selection.
- Fixed the browse prompt collapsing the space after an item's icon.

## 0.8

- Browse and command-palette history moved from page `localStorage` to extension
  storage, so it survives "clear site data". Browse history is namespaced per
  host; existing history is migrated on first read.

## 0.7

- Keep focus in the editor after saving a code file, without moving the cursor
  (SAS Studio rebuilds the file tree on save, and the new tree steals focus).

## 0.6

- Fixed Save As at path throwing on the production instance when the
  destination tree had not finished loading.
- Removed the two scroll-tree-to-path actions (browse_ss covers the same
  navigation); the surviving one moved off a hotkey Linux swallows.
- The command palette and browse prompts keep keyboard focus when a SAS Studio
  dialog (e.g. Save As) opens over them, instead of freezing.
- Browse prompts reveal a truncated path's tail two ways: the focused row's
  caption auto-scrolls, and hovering any row shows the full value.
- The command palette lists the 5 most recently run commands first, so the
  last-run command is the pre-selected first row on reopen.
- The file and library browsers show bookmarks (`Ctrl+B`) and recent items when
  the prompt is empty, and filtered by what you type when it points outside the
  loaded folder — the library browser's history had been invisible entirely.

## 0.5

- The options page documents the custom vim ex-commands (`:w`, `:w <path>`,
  `:q`, `:wq`, `:x`).
- New LSP line limit (default 500, 0 = no limit): skips the SAS language server
  for files longer than N lines.
- The run-progress dialog is minimized to the status bar the moment a program
  starts, so the app stays usable while it runs; a second foreground run is
  refused, and requests the server would queue behind the run say so instead of
  looking broken.
- Closing a dirty text-viewer tab prompts for confirmation, like the code editor.

## 0.4

- SAS language server integration: LSP-backed completion, hover, diagnostics and
  semantic highlighting in `ace/mode/sas` editors, on by default. It is
  additive — without the built server bundle the editor works exactly as before.
- Embedded Python/Lua highlighting inside `PROC PYTHON`/`PROC LUA` blocks.
- `lib/` is now generated output: `build_lib.sh` is the single place third-party
  library versions are recorded and rebuilt.

## 0.3

- New file action (Alt+N): create a new SAS program, same as F4.
- Save file at path action (Alt+Shift+S): drives SAS Studio's own Save As dialog
  from a typed absolute path.
- The editor picks its syntax mode from the file's extension instead of always
  defaulting to SAS.

## 0.2

- In-page hotkeys for the editor and native-mouse toggles.
- Re-vendored pristine Ace 1.43.3, with the fork's changes reproduced at runtime.
- The popup shows the SAS Studio auth cookies with a copy button.

## 0.1

Initial release, growing a Tampermonkey userscript (floating Ace container) into
a full Manifest V3 extension that monkey-patches SAS Studio in the page's MAIN
world.

- **Editor swap**: SAS Studio's built-in editor is replaced with Ace at runtime,
  toggled repeatably with no page refresh.
- **SAS language support**: custom Ace mode and snippets, dark/light theme
  following the system preference, persisted editor config applied live.
- **Command palette & browse_ss**: a prompt UI for browsing and opening files,
  library items and open tabs, with history and a global hotkey.
- **Text viewer**: "View file as text" opens in an editable Ace overlay with
  dirty marking and save (button, `Ctrl/Cmd+S`, vim `:w`/`:wq`/`:x`).
- **~25 SAS Studio UX fixes** absorbed from the standalone userscript — tab
  management, tree navigation, keyboard shortcuts, clipboard, context menus.
- **Configuration UI**: the popup (toggles, command palette) and the options
  page (patches, hotkeys, editor settings, snippets).
</content>
