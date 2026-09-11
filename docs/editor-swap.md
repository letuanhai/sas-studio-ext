# `src/editor-swap.js` — the Ace editor replacement

Defines `AceEditorAdapter` (a full reimplementation of the `SAS.Editor` API on top of Ace) and the `window.__ssExt`
singleton (`active`, `activate`, `deactivate`, `toggle`, `loadNewAce`, `browse`, `commandPalette`, `applySnippets`,
`applyAceConfig`, `libPath`, `aceConfig`, `diffPrefs`).

The language-server half lives in [language-servers.md](language-servers.md).

## Dispatcher patches

Installed once on first injection (`installAceReplacementPatches`, guarded by `_aceReplacementPatched`):

- `SAS.Editor` becomes a function returning either an `AceEditorAdapter` or the original editor, per `__ssExt.active`.
- `DMSEditor.prototype.createCodeEditor` is wrapped the same way (original saved on `__ssExt`).
- `DMSEditor.prototype.successfulSave` is wrapped for the dirty-gutter baseline.
  It is the one method every code-tab save path ends in, and always called as `this.successfulSave(...)`, so unlike
  `saveFile` — which the toolbar button hitches at construction — a prototype wrap also covers pre-existing tabs.
- `appDMS.createFileView` is wrapped (`_createFileViewPatched`) for text viewers.

`activate()`/`deactivate()` never touch the `window.ace` global;
they walk every open tab converting its editor in place and re-binding `textChanged`/`selectionChanged`/`caretMoved`.
The toggle is idempotent and repeatable.
**Undo history does not survive a toggle in either direction.**

## `loadNewAce()`

Loads our Ace from `lib/ace/src-noconflict/` once, onto `window.__ssAce`.

**The two ace libraries on the page have separate module registries** — `tools/build_lib.sh` builds ours with its
registry namespaced to `__ssAce`, so SAS Studio's own 1.x build keeps `window.ace` and its stock editor to itself.
Nothing swaps, pins or restores a global, so a lazily loaded keybinding/theme/mode cannot land in the wrong library in
either direction (which is how vim's `:w`/`:q` once vanished), and since SAS's editor tokenizes against ITS ace,
bumping `ACE_VERSION` cannot break it and needs no compat shims.
Our library lives in one closure variable here;
`options.js`/`ace-seed.js` do the same, and `src/ace/*.js` carry the `__ssAce.define`/`__ssAce.require` names in source.

Called from `ss-fixes.js`'s `init()` at page load (after `waitForElm(".dijitTreeNode")`) with the toggle still off, and
from `toggle`/`browse`/`commandPalette`.
Memoized on the in-flight promise (`ssExt._loading`), the page-load call sitting outside their `_pending` chain.

What else it does:

- `dropOldAceStyles()` removes every pre-existing `<style id="ace*">`/`#vimMode` element, injected by SAS's own 1.x ace
  as a side effect of importing `EditSession`.
  `importCssString` dedupes by element id, so any id SAS registered first would silently drop OUR version.
  SAS needs no ace CSS (its editor DOM is EditorView.js's markup), which is also why ours can stay attached permanently.
- Eagerly loads `mode-python.js`/`mode-lua.js` (embedded by our SAS mode), `mode-sas.js` and `mode-saslog.js`.
  ace's `define()` has no dynamic dependency loading, and all are local resources.
- Overrides the module URL for `ace/keyboard/vim`/`emacs`/`sublime`/`vscode` to `keybinding-<name>.js`;
  this build otherwise resolves them to a 404, silently disabling non-Ace keyboard handlers.
- Points `ace.config.setModuleUrl` at `src/ace` for `ace/mode/sas`/`ace/snippets/sas`, derived from `libPath` by
  swapping `/lib/ace/src-noconflict` for `/src/ace`.
- Loads `ext-diff.js` purely for `ace/ext/diff/providers/default`'s `computeDiff`, plus `ext-settings_menu.js`.
- `await`s `installVimExCommands()`, registers the three extra completers, calls `syncOverlayDefaults()`.
- Injects three sheets, below.

**Call ordering matters**: `__ssExtApplyAcePatches` runs after `ext-language_tools`/`ext-prompt`/`ext-statusbar` but
BEFORE `ext-settings_menu.js`, whose bundled `ace/ext/options` snapshots `modelist.modes` at load time into the Mode
dropdown, so the SAS entry must exist first.

### The injected sheets

- `#ssExtVimCursorFix` — some themes style `.ace_cursor` at the same specificity as `keybinding-vim`'s
  `.normal-mode .ace_cursor` rule and load after it, killing the vim block cursor.
- `#ssExtNoStrayScroll` — `.ace_gutter`/`.ace_scroller` get `overflow: clip` instead of `hidden`.
  Both clip oversized content (`.ace_gutter-layer` is `height: 1000000px`), so as `hidden` they are real scroll
  containers, and anything scrolling by feel rather than through ace's API scrolls them — SurfingKeys picks the gutter
  and slides the line numbers out of step with the text, with no way back short of a reload.
  `clip` keeps the clipping and removes the scroll container;
  ace never reads or writes either element's `scrollTop`, and the real scrollbar divs still give SurfingKeys a target.
- `#ssExtCompletionPopup` — a 400px minimum width, `!important` because `importCssString` PREPENDS to `<head>` and would
  otherwise lose the tie with ace's own 300px rule.
  Scoped away from `.ace_prompt_container`/`.ace_browse_ss_container`, whose lists size to their box with an inline
  `width:100%`.

## Text viewers

While active, "View file as text" gets an `AceEditorAdapter` overlay (registry in `__ssExt._textViewers`) laid over the
real `SimpleTextarea`, which is kept alive in the widget tree (just hidden) so AppDMS's positional load/refresh code —
which indexes `pane.getChildren()[1].getChildren()[0]` rather than going through `tabHolder.simpleTextArea` — keeps
working untouched.
The widget's `.set("value", ...)` is patched to mirror writes into Ace.

The overlay is always editable;
an edit marks the tab dirty (`*name`, matching `applyChangedIndicationToTab`).
Save is wired three ways — a toolbar `Save` button (TXT/LOG only), `Ctrl/Cmd+S`, and vim `:w`/`:wq` — all POSTing to the
workspace endpoint, mirroring `DMSEditor.saveFile`'s plain-file path.

`activate()` also calls `swapTextViewersToAce()` for viewers that already exist: the `createFileView` wrapper only sees
viewers created while active, and tabs restored from the last session are built by `loadPersistedTabs` long before
injection.
Only `createFileView` ever sets `tabHolder` on a tab, so that is the whole "is this a text viewer" test;
conversion goes through the same `convertTextViewerToAce(item, tabHolder)` the wrapper uses.

`deactivate()` disposes the adapter, clears the dirty marker, unhides the textarea, restores its original `.set`.
Consequence for the smoke test: `_textViewers` is not empty just because a viewer was closed, so its registry-cleanup
check is baseline-relative.

## Prompts and the command palette

`commandPalette(libPath)` (libPath optional once `ssExt.libPath` is known) serializes through the same `_pending` chain
as `toggle`/`browse`.
It resolves the focused Ace editor **before** opening anything (`focusedAceEditor()` — `_textViewers` first, then
`getAllTabObjects()` code tabs, via each candidate's `.isFocused()`), then `loadNewAce()`s and calls
`openCommandPalette(focusedEditor)`.
Three entry points: the in-editor command (Alt-Shift-P), a global hotkey that works with Ace off and nothing focused
(`sw.js` pre-injects this file and seeds `libPath` on every page load), and the popup's button, which passes an explicit
`libPath`.

`openCommandPalette` builds on the stock vendored `ace/ext/prompt`.
Entries: always `SS-Ext: <label>` per `SSF_TOOLS` action (which includes `toggleEditor`/`toggleNativeMouse`, so no
special-casing), plus — only when an editor was passed — that editor's own commands, walking
`editor.keyBinding.$handlers`, deduped by name, mirroring `prompt.commands`' `getEditorCommandsByName` and excluding
`["insertstring","inserttext","setIndentation","paste"]`.
The runner functions live in a side table keyed by `entry.command`, because `getCompletions` JSON-clones the entries on
every filter and would strip them.

History is `SsCmdPaletteHistory` in `chrome.storage.local` (global/unprefixed, command names being server-agnostic): an
MRU list of `entry.command`, cap 5, recorded in `onAccept`.
Listed entries are MOVED to the front, deduped not copied, so the last-run command is the pre-selected first row;
`FilteredList.filterCompletions` filters without sorting, so matching recents stay on top while typing.
History only reorders entries present in the current list, so editor-only commands never surface in the global palette.
`getCommandHistory()` must return a COPY: `_browseSsStore.get()` hands back the live array and the MRU pass reverses
what it gets.

**`openListPrompt()` is the one call site four features share** — the command palette, the vim mappings list, the Lua
references list and the rename preview — after three near-verbatim copies of the same `FilteredList` + `getPrefix` +
clone-and-filter block.
Callers differ only in: the entries, the empty-list message, what accepting does, whether the typed text FILTERS the
rows (a picker) or is itself the answer (`filter: false`), and `highlight` (a fixed string for `getPrefix` to answer,
decoupling what the rows highlight from what is typed).
`entries` is a FUNCTION of the current input, which is what lets the rename preview rebuild per keystroke;
a picker ignores the argument.

`installDialogFocusPriorityPatch()` patches `dijit.Dialog.prototype.show`/`focus` so an open SS-Ext prompt keeps focus
over SAS Studio's dijit dialogs, both of ours being plain z-index overlays with no native focus trap.
dijit's `show()` autofocus is skipped while a prompt is open, and `Dialog.prototype.focus()` — the `focus.watch`
trap that yanks focus back inside the top dialog — no-ops when the live focus is already inside our prompt.
Without it, opening Save As over the palette froze it.

`browse(kind, libPath, snippetsText)` calls only `loadNewAce()`, not `activate()`.

## Popup sizing

`installResizablePopups(ace)` makes every ace popup resizable, `RESIZABLE_CSS` supplying the handles: `resize: both` on
`.ace_editor.ace_autocomplete`, `resize: horizontal` on the two prompt boxes (given a plain `width` instead of ace's
`max-width` + `width:100%`, a max-width clamping the drag), `resize: vertical` on the list inside a prompt.
One handle per axis is forced by ace's own CSS: `.ace_autocomplete` is `position: absolute`, so a prompt's completion
list is not laid out inside the white box at all, and the box's width is mirrored onto the list's inline `max-width`.

CSS alone isn't enough — ace re-derives an autosizing editor's height from `$maxLines` on every render — so a
`ResizeObserver` turns a dragged height back into `$maxLines`, plus `$minLines` for prompt lists so a short list still
fills the dragged box (the editor's own popup gets only the cap).
It hooks `VirtualRenderer.prototype.$autosize` rather than wrapping `AcePopup`: both `ext-language_tools` and
`ext-prompt` capture `AcePopup` in a module closure when they load, and `$autosize` is the one place that runs per popup
render AND has the renderer to hand the observer.
Dragged prompt sizes are remembered in `promptSizes` (module-level, by box class name, page session only — every open
builds a fresh element), skipping a detached popup so closing one can't save a junk size.

`installAutosizeCompletionPopup(ace)` sizes the editor's completion popup to its CONTENT, which ace never does
(`AcePopup` stubs the popup session's `$computeWidth` to 0).
It wraps `Autocomplete.prototype.openPopup` — the one entry point the editor's popup goes through and the prompt lists
don't — and defers `sizePopupToContent` to a one-shot `renderer.once("afterRender")`, `characterWidth` still being 0 at
`openPopup` time.
The width is the widest row's `caption + meta + message` in characters plus the meta's margin, the scrollbar gutter and
the borders, clamped to 400…800px and the window;
an absent inline width counts as the 400px minimum, so a popup of short rows is left alone.
Only a changed width repositions the popup, the listener being one-shot to stop that looping.

**A size the user drags the popup to becomes its ceiling**, kept in `completionPopupSize`.
Width caps the clamp — including the 400px FLOOR, somebody who pulled the box in to 300 having meant 300 — and height
rides the `el.__ssExtLines` → `$maxLines` path.
Telling a drag from our own write is the whole trick, both landing as an inline `style.width` on one element:
`sizePopupToContent` records what it wrote as `__ssExtAutoWidth`, and the observer treats any other inline width as the
user's.
`ssExtCompletionPopup`'s 400px rule uses a doubled class rather than `!important` for the same reason — an author
`!important` would beat the inline width a drag writes.

## Completers

Registered in `loadNewAce()` onto `ext-language_tools`' global array, all before any editor exists: `_maybeRegisterLsp`
replaces `editor.completers` with its own copy, which a later `addCompleter` can't reach.
`ssextSasFns` and `ssextProcLua` are in [language-servers.md](language-servers.md).

**`ssextOtherEditors`** (score 0) — ace's built-in text completer only looks at the CURRENT session, so this harvests
the words of every OTHER live adapter (`allAdapters()`, the shared text-viewers-then-code-tabs walk).
Words are cached per session in a `WeakMap` and dropped on that session's `change` (one listener per session ever — the
entry object stays, only its `.words` is cleared), splitting every other tab's full text per keystroke being otherwise
the cost.
Score 0 puts it below the local text completer's distance-based scores and far below the LSP's.

**`ssextSasContext`** (score 1000, above the LSP's 0) — covers what the SAS server cannot answer, from the same library
tree as `sas/getLibList`:

- **PROC SQL data set names.** Inside `proc sql;` every caret position is zone `PROC_STMT_OPT` and the server offers
  only option NAMES, its syntax data typing the `FROM` option as `"value"` rather than `"dataSet"`.
- **Column names.** The server has no column zone at all (`getDocumentVariables()` is a `//TODO:` stub).

`stepAroundCursor(session, pos)` cuts ±200 rows around the caret — it must reach PAST it, `select | from sashelp.class`
naming its table after the caret — bounded by the last `proc`/`data` behind and the next `run;`/`quit;`/`proc`/`data`
ahead (a `run;`/`quit;` BEFORE the caret means the step is over).
`tableRefs(step)` pulls `{lib, table, alias}` out of `from`/`join`/`into`/`update`/`table`/`set`/`merge`/`data=`, where
only the SQL keywords take an alias (`from a.b x` aliases, `set a b` is two data sets), with a `NOT_A_TABLE` stop-word
set.
Columns resolve BY NAME through the two cached listings, so no tree path is built by hand, and are served synchronously
from `columnsByRef` while `warmColumns()` fills it in the background — skipped while `window.__ssfRunDialog` shows a run
in progress, that request otherwise queuing behind the program.
They are offered step-wide rather than after an allowlist of clauses, which misses more than it saves, except at the
start of a statement, where a keyword belongs.
A `name.` before the caret scopes them to that TABLE;
SQL aliases are parsed but deliberately not resolved, so `x.` offers nothing rather than a guess.

## Snippets

`applySnippets(snippets)` registers the user's custom Ace snippets, additive over the built-in set;
a no-op until the new Ace lib is loaded.

Its argument is a map of snippet SCOPE → snippet file text, the scope being the mode id's last segment
(`sas`/`lua`/`text`/`saslog`), which is what `snippetManager` registers against — so one set per language falls out of
passing the scope through instead of hardcoding `"sas"`.
Every previously registered scope is unregistered first (`ssExt._userSnippetsParsed` is the same map, parsed), so a
re-apply can't double-register and a dropped language loses its snippets.

There is deliberately no compatibility branch for the bare SAS string this used to take;
`ssExt.userSnippets` defaults to `{}`.
The hazard that IS real runs the other way — a tab still holding the previous `editor-swap.js` when the new `sw.js`
pushes it a map logs one caught `[SS Ext]` error and stops applying snippets until reload, which no branch here can
prevent.

## Config and the settings menu

`ssExt.aceConfig` (`{ darkTheme, lightTheme, options, vimrc, lsp, lspMaxLines, luaLsp, procLuaLsp }`, seeded by `sw.js`, refreshed
by
`applyAceConfig(config)`) backs `getAceConfig()`.
The adapter constructor reads it for its initial theme and `ace.edit()` options;
`applyConfig(cfg)` re-applies live — theme through the existing matchMedia machinery (`this._darkTheme`/`_lightTheme`
are read live by the handler, not captured at construction), plus `setOptions`.
`applyAceConfig` calls `applyConfig` on every open adapter and reapplies the vimrc if `config.vimrc` changed.

**There is no custom preferences panel**: Ace's own settings menu (`showSettingsMenu`, `Ctrl-,`) is THE settings UI, and
appears in the command palette whenever an editor is focused.
Loading `ext-settings_menu.js` is enough for it to work — it bundles its own `OptionPanel`, so the eager load makes the
stock command's lazy `loadModule` a no-op rather than a second HTTP load.
`installSettingsMenuPersistence()` patches `OptionPanel.prototype.setOption` so panel changes stick: after the original
runs, an `option.path` other than `"theme"`/`"mode"` updates `aceConfig.options[path]`, live-applies, and is
postMessaged for `relay.js` to persist.
`options.js` installs the identical hook for the snippet editor, writing straight to storage.

`syncOverlayDefaults()` keeps the ace-built overlays in step with dark mode, called from `loadNewAce()`, from
`applyAceConfig()`, and from one page-level `matchMedia` listener since a prompt can be opened with no editor open.
The palette prompt, browse_ss and the settings menu are plain divs on `document.body` whose inner editors are created
with NO theme and whose containers ace styles `background: white`, so it points ace's DEFAULT editor theme at whichever
of our two is current (our SAS editors pass a theme explicitly) and toggles a `ssExtDark` class on `<body>` that the
static `#ssExtDarkOverlays` sheet keys off.
It also points ace's default FONT SIZE at `aceConfig.options.fontSize` — ace's own 12px is a squint next to a 15px
editor, and the palette's input only takes the focused editor's size when there IS one.
That sheet sets `color-scheme: dark` on `#ace_settingsmenu`/`#kbshortcutmenu`, the settings panel being a `<table>` of
NATIVE controls where a `background-color` on a `<select>` computes but is never painted;
buttons and text inputs need explicit colours too, something in the page painting them white.

## vim

`installVimExCommands()` loads `keybinding-vim.js` and is AWAITED inside `loadNewAce()`, so the ex-commands and the
vimrc are registered before it resolves.
They go on the shared `ace/keyboard/vim` module and resolve the acting `cm.ace` back to either a text-viewer entry or a
code-editor tab, so they work in both:

| Command | Does |
|---|---|
| `:w`, `:wq` | save (`:wq` also closes) |
| `:w <path>` | `ss-fixes.js`'s `saveFocusedFileAtPath(path)`, the same save-as flow as the `saveFileAtPath` action |
| `:q` | close the tab |
| `:x` | remapped off save-and-close to the `runCurrentProgram` action, submitting like F3 |
| `:marks` | the letter marks, in the bottom notification `:registers` uses |

`installVimFoldMotions(vim)` (own try/catch, guarded by `Vim.$ssExtFoldMotions`) adds fold NAVIGATION: ace's vim ships
only the `zc`/`zo`/`za`/`zf`/`zd` toggles, and ace itself has no command to move between folds either.
The three row pickers (`nextFoldStart`/`prevFoldEnd`/`enclosingFold`, on `ssExt._foldNav`) walk the same fold widgets
the gutter renders from: `zj` = next `"start"` below, `zk` = previous `"end"` above, `[z`/`]z` = the start/end of the
innermost fold containing the cursor, found by walking up to the nearest `"start"` whose `getFoldWidgetRange` still
reaches the cursor row.
`zk` needs `foldStyle: "markbeginend"` (`DEFAULT_ACE_CONFIG`'s), ace's own `"markbegin"` emitting no end widgets.
They are registered with `Vim.defineMotion` + `Vim.mapCommand` and no `context`, so they work in visual and
operator-pending mode too (`d]z`);
`mapCommand` unshifts onto `defaultKeymap`, which is what makes `[z`/`]z` win over the generic `[<character>`
`moveToSymbol` motions and puts them in the mappings listing for free.

**Marks get a gutter.** ace's vim keeps them on the CodeMirror adapter (`editor.state.cm.state.vim.marks`, which vim.js
shifts on every edit) and exposes them nowhere.
`installVimMarkGutter(vim, ace)` wraps the vim HANDLER's `attach`/`detach`, not our adapter: that hook fires for every
editor given the vim handler, including a runtime switch from ace's settings menu, and `detach` is where the `cm` dies.
On attach it listens to `vim-command-done` (covering `ma`, `` `a ``, `:delmarks`) plus the editor's `change`;
`refreshVimMarkGutter` re-applies the whole set through `addGutterDecoration`/`removeGutterDecoration` and returns early
when nothing changed, running per keystroke.
One class per mark keyed BY CHAR CODE (`ssExtVimMark-97`), HTML class selectors being case-sensitive so `a`/`A` would
collide;
a generated 52-rule sheet prints the letter with `::after` in the gutter cell's left padding.
Only letter marks are shown — `'`/`<`/`>`/`[`/`]` are vim's bookkeeping, and real vim doesn't gutter those either.
The scrollbar overview is left alone: ace's decorator layer draws fixed-width bars with no room for a label.

`showVimMappings` (an `SSF_TOOLS` entry, unbound by default) lists EVERY mapping — vim.js's ~190 built-ins and the
user's.
ace's vim implements no listing;
what it exposes is `exports.handler.defaultKeymap`, the complete set with `Vim.map`'s unshifted user entries on top.
Far too long for vim's notification box, so it goes through `openListPrompt()`, one row per mapping (`keys` plus what it
dispatches, mode as `meta`) so the filter searches keys and behaviour alike.
It is deliberately NOT a `:map` ex-command: the ex dialog's `close()` ends with `editor.focus()`, so a prompt opened
from there loses focus, and deferring past the close didn't hold either.
A `:mapclear` swaps the module's own array reference, which `handler.defaultKeymap` doesn't follow, so the listing is
stale until reload.

### vimrc

`aceConfig.vimrc` is a small subset of vim config lines (`map`/`nmap`/`imap`/`vmap`, `noremap` and `unmap` variants —
one mapping per line, `"` comments, unsupported lines warn and are skipped) applied to the shared module's
`Vim.map`/`noremap`/`unmap`.
`applyVimrcLine(Vim, line, keymap)` is the parser, duplicated (not shared) in `options.js`, MAIN-world and options-page
code having no way to share a file.
`applyVimrcConfig(text)` and `installVimExCommands()`'s module-loaded callback both drive it, tracking
`ssExt._vimrcApplied` (a counter, for test visibility) and `_vimrcLastText` (to skip a no-op reapply).
Removing a line doesn't undo that mapping until reload — `Vim.unmap` runs only for what the current text still asks to
unmap.

**A leader key needs `dropShadowingAlias`**, which is what the `keymap` argument is for.
ace's vim takes the first FULL match and discards every partial one (`commandDispatcher.matchCommand`), with no
`timeoutlen` to sit on the ambiguity, so the built-in `{ keys: '<Space>', type: 'keyToKey', toKeys: 'l' }` permanently
shadowed a user's `<Space>d`.
So a user mapping whose lhs is more than one key drops any default entry whose `keys` is exactly its first key AND whose
`type` is `keyToKey` — what a vim user writes as `nnoremap <Space> <Nop>`.

Two bounds on that drop:

- It is scoped to the mapping's own mode.
  A context-less alias shadows every mode so it always goes, but a mode-specific one is left alone for a mapping in
  another mode — `s` and `S` each have a normal AND a visual entry, and an `nmap sa` has no business breaking
  visual-mode `s`.
- The `keyToKey` restriction is the whole safety of it: those 31 defaults are pure aliases (`<Space>`, `<CR>`, `<BS>`,
  `s`/`S`, the arrows), whereas the bare key of an operator (`d`, `c`, `y`) has to keep working.

An **`<Cmd>name` right-hand side** (vim 8.2's own form, `<CR>` optional since nothing here is an ex command) maps the
key
to an ACE COMMAND via `Vim.mapCommand(keys, "action", "aceCommand", { name })` — ace's vim has exactly one way to reach
an ace command, and this is what makes the diff and Lua-navigation commands mappable at all.
The leader-alias drop applies to those lines too.

## The unsaved-change gutter

Every adapter keeps `_savedLines` (content as last loaded or saved) and, 250 ms after the last edit, diffs it against
the session: `ssExtDirty` (full-height 2px bar) for an added/changed line, `ssExtDirtyDel` (half-height, red) on the row
that closed the gap for a deletion, clamped to the last row for a deletion at EOF.

The differ is ace's own `computeDiff`.
Deliberately not `MinimalGutterDiffDecorator`: it renders into recycled gutter cells and its class removal is a no-op
(`classList.remove(Object.values(...))` passes an ARRAY, removing the token `"mini-diff-added,mini-diff-deleted"` and
never the real classes), smearing stale marks across rows as you scroll.
`addGutterDecoration` has none of that, which is why this reuses the vim-mark path.

`markSaved()` resets the baseline, from the constructor, from `setText()` (every caller of which is a load/revert path)
and from both save funnels — the `successfulSave` wrap (reading `editorContentChanged` after calling through keeps
autosaves out without repeating its condition) and `setViewerDirty(entry, false)`.
`dirtyRows()` swallows a missing `ext-diff` module and reports no marks.

ponytail: gutter only, no scrollbar overview — that would mean replacing `renderer.$scrollDecorator` with
`ScrollDiffDecorator`, and `ace-patches.js` already has a stake in the decorator layer.
A toggle mid-edit re-baselines the DIRTY text, so the marks don't survive one.

## The inline editor

`toggleInlineEditor` (`Alt+Shift+I`): a second editor embedded as a LINE WIDGET at the cursor row, on a CLONE of the
session — same `Document` and same undo manager, so edits and undo are shared, but its own scroll, folds and caret.
A second view of one file, e.g. a macro definition kept in sight while its call site is edited.

Ported from ace's kitchen-sink demo (`demo/kitchen-sink/inline_editor.js`), which no ext ships.
Three changes from it:

- The widget is RESIZABLE — `resize: vertical` plus a `ResizeObserver` calling the inner editor's `resize()` and
  `widgetManager.onWidgetChanged(widget)`, ace re-measuring a widget's height from `el.offsetHeight` only for widgets it
  has been told changed.
- It is an editor COMMAND rather than the demo's F3, which is SAS Studio's Run Program (`Alt+Shift+E` is out too, being
  ace's `goToPreviousError`).
- The demo's bare-Esc close handler is dropped, having eaten vim's way out of insert mode.

`cloneSession()` is ext-split's `$cloneSession` copied in: there it is an INSTANCE method, unreachable off the
prototype, and the only thing that file would be loaded for.
`dispose()` closes an open one.

## The diff view

`toggleDiffSaved` opens ace's diff view INSIDE the focused tab, not in an overlay, so the tab keeps its caret, LSP
registration and vim handler.
It serializes through the `_pending` chain and finds the focused adapter (`focusedAdapter()`).

Two shapes, flipped by `toggleDiffMode` and remembered: `"split"` puts a read-only editor for the other side beside the
live one, `"inline"` (`createDiffView`'s `inline: "b"`) draws that side into the live editor's own layers.
`splitTabPane()` makes room: `ace.edit()` was handed the tab's own pane node, so the editor IS that element and there is
nowhere inside it for a second one — the new editor goes beside it and the parent is flexed, every touched inline style
recorded for `restore()`.
`flex-direction` is then the whole of the layout, `rotateDiffLayout` cycling `row` → `column` → `row-reverse` →
`column-reverse`, a quarter turn each time, other side first.

Both prefs live in **`chrome.storage.local`'s own `diffPrefs` key** (`{ mode, layout }`), written through
`persistDiffPrefs()` → `relay.js`, seeded back by `sw.js`, with no live-apply listener since only the page writes them.
Deliberately NOT a corner of `aceConfig`, which both `sw.js` and `options.js` rebuild from a fixed key WHITELIST, so
anything not named there is dropped on the round trip and pushed back stale.

`diffAgainstFile` is the same diff against ANOTHER file: `browse_ss.pick_file(cb)` (the file browser with `openItem`
swapped for a callback and `fileActions` off, `onClose` answering `null` for a dismissal), then
`fetchWorkspaceFile(uri)`
against the same workspace URL `saveTextViewer` POSTs to.
Like every session-bound request it queues behind a running program, which ss-fixes' busy notice already explains, so it
carries no timeout of its own.

**The prompt is deliberately NOT awaited inside the `_pending` chain.** It waits for a person, and that chain serializes
every other ssExt action, so awaiting it froze the toggle, browse and the palette for as long as the prompt stood open.
`doDiffAgainstFile` hands the callback off and returns, as `browse()` does;
`openPickedFileDiff` re-checks that the tab is still there and has no diff, before and after the fetch.

Either source ends in `openDiff(adapter, text, label)`, which keeps both on the adapter
(`_diffOther`/`_diffLabelText`) so a mode flip rebuilds without re-reading the file.
The label — `last saved`, or the picked path — shows for as long as the diff does, via `showDiffLabel()`: a second
element on the status LINE, pinned bottom-right of whichever pane holds the other side, styled like `ssf-ace-statusbar`
and ellipsized.
Not inside the status bar itself, whose `updateStatus` rewrites that element's whole `textContent` every render.
A toast said the path once and was gone, which is no use to somebody who left the diff open, so the file diff raises no
toast at all (failures still do).

`closeDiff()` detaches the view, destroys the second editor and restores the pane;
`dispose()` calls it.
`openDiff` ends by focusing the LIVE editor, and `diffTarget()` falls back to whichever adapter has a diff open when
nothing is focused — otherwise a split opened from the prompt, or clicked into on the read-only side, could not be
closed.

**Two things the diff module makes you do yourself**, both showing up as "the diff is simply empty": build it through
`createDiffView` (the `SplitDiffView`/`InlineDiffView` constructors leave the module's dummy provider in place), and
call `view.onInput()` once at attach (nothing computes a first diff until an edit reaches `onInput`).

**Seven EDITOR commands**, not `SSF_TOOLS` actions, every one needing an editor to mean anything: the three toggles,
the nav pair `gotoNextDiff`/`gotoPreviousDiff` (`Alt+Down`/`Alt+Up`), `switchDiffPane` and `rotateDiffLayout`.
Registered on every adapter's editor — and on the split's read-only editor, which has a command set of its own — and
left there for the editor's whole life.
So they appear in the palette's per-editor list, are bindable from ace's settings menu and mappable from a vimrc, and
carry no `SSF_TOOLS` hotkey.

They stay registered ALWAYS and decline through `isAvailable` while no diff is open, which is what lets the nav pair
hold `Alt+Down`/`Alt+Up` without stealing them: ace keeps several commands per key and `CommandManager.exec` walks them
newest-first until one runs, so with no diff those keys still reach `movelinesdown`/`movelinesup`.
Taking the binding at attach and giving it back at detach is a trap — `removeCommand` deletes the binding outright
rather than restoring what it displaced.

`gotoNextDiff` deliberately does not call the view's `gotoNext()`, which drives `editorA`, i.e. the other side, and
reads the chunk's `old` range.
`gotoDiffChunk()` walks the chunks' new-side start rows on the live editor, with no wrap at either end.

ponytail: no in-editor way to APPLY a chunk from one side to the other — ace has no such command either.
