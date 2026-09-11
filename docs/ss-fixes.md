# `src/ss-fixes.js` — SAS Studio UX fixes

Independent UX fixes/features (tab management, tree navigation, keyboard shortcuts, clipboard, context menus), split
into `ACTIONS` (one-shot commands, e.g. `reloadCurrentFile`) and `PATCHES` (passive monkey-patches applied once at
init, e.g. `keepAlive`).

Exposes `window.__ssf = { init(settings), run(name), saveFocusedFileAtPath(path), copyText(text), notify, runFocus }`.

`init()` waits for `.dijitTreeNode`, kicks off `__ssExt.loadNewAce(libPath)` fire-and-forget, applies enabled patches,
runs any action `setup()`s, and binds hotkeys.
`run(name)` invokes one action on demand (the command palette's `SS-Ext:` entries).

The dominant pattern for patches is wrap-and-delegate: save the original method, replace it with a wrapper that calls
through.

## Clipboard and hotkeys

`copyText` is the one clipboard path for the whole extension: `navigator.clipboard` is secure-context only and SAS
Studio is normally plain http, so it falls back to a temporary textarea + `document.execCommand("copy")` (needs the
caller's user gesture;
it restores focus afterwards).
`ext-browse_ss.js`'s copy keybindings call through it.

Global hotkeys are bound on `window` in the CAPTURE phase and `stopPropagation()`, so `bindKey` skips them entirely
while one of our prompts (`.ace_browse_ss_container`/`.ace_prompt_container`) is open — otherwise an overlapping
binding never reaches the prompt (Alt+C is "Copy current tab URI" globally and "copy item name" in browse_ss).

## Keyboard entry points into SAS Studio's own widgets

The tab bar, the pane bar and the side-bar trees are all dijit `_KeyNavContainer`s, so the arrow keys already navigate
them once one holds DOM focus — nothing in the app ever moves focus there.
Four actions do:

- `focusTabBar` → `tabs.getFocusedTab().tab.controlButton`.
- `focusPaneBar` → the `controlButton` of the selected pane in whichever of
  `sasSuiteTabContainer`/`rightTabs`/`bottomTabs` owns it (the latter two don't exist until a pane is dragged there).
- `focusSideBarTree` → `tree.focus()` on `getCurrentTargetTree(["library", "projects"])`.
  That works despite `noTreeFocusSteal` because `_KeyNavContainer.focus()` goes through `focusChild`, not the
  `focusNode` that patch suppresses.
  In MAXIMIZED view the side bar is `display: none` and `tree.focus()` is a silent no-op that reads as a broken hotkey,
  so it refuses with a notice instead;
  un-maximizing on the user's behalf would be a surprising side effect.
  Max view is a SERVER-SIDE preference, so the smoke checks for it take it off for the duration and put it back.

## Tab and pane groups

SAS Studio has at most two tab GROUPS: `tabs.mainTabContainer` plus a `secondaryTabContainer` that `_dropTab` creates on
a drag to the right/bottom edge and `_onTabRemove` destroys when its last tab leaves, mirrored in
`tabs.mainTabs`/`tabs.secondaryTabs` (which is how an action tells which side it's on).

- `switchTabGroup` — with only two groups a toggle IS the switch.
  Ends in `focusTabEditor(tab)`, factored out of `focusCodeEditor` because it focuses a tab that isn't focused yet.
- `moveTabToOtherGroup` — `tabs._dropTab(region, tab.tab, sourceContainer)`, the same call a drag makes, so it creates
  the secondary container when there is none (region `"right"`, or the existing split's region — passing the other one
  would make `_dropTab` rebuild the container) and destroys it when its last tab leaves.
  Refuses with a notice whenever the MAIN group holds fewer than two tabs: SAS Studio has no empty-main-group state.
  The other direction is never blocked.
- `unsplitTabGroups` — `_dropTab("", ...)` every secondary tab back, over a SNAPSHOT of `secondaryTabs` (which
  `_dropTab` splices as it goes), restoring the previously focused tab afterwards since each move selects what it
  dropped.
  The one case moving tabs one at a time can't reach, the main-group guard stopping before the last tab.

`switchPaneGroup`/`movePaneToOtherGroup` are the same pair one level down for a code tab's PANE strips
(`paneGroups(editorTab)` = `sasSuiteTabContainer` + whichever of `rightTabs`/`bottomTabs` exist — shared with
`selectNextPane`/`focusPaneBar`), via `editorTab.dropTab(region, "", pane, sourceContainer)` and the same
can't-empty-the-main-group refusal.
Panes get up to THREE strips, so `switchPaneGroup` cycles rather than toggling, and `resetLayoutCurrentTab` is already
the wholesale un-split.
Focus lands via `focusPane`: the caret for an editor pane, the chip for any other.

`tabsContextMenuCopyUri` builds **one `dijit.MenuItem` per menu**.
A dijit widget has a single parent and `addChild` MOVES it, so a shared item left the main menu on the first split and
was destroyed with the secondary container, after which the next split threw out of `_addSecondaryTabContainer` and left
a half-built container behind — which then made `switchTabGroup` fail silently.
Its `createTabsPopup` wrapper also has to call the original with `.call`, not `.apply(this, tabMenu)`, or the secondary
group's tab menu never gets SAS Studio's own items.

## Opening items

`openItem(item)` — the one call into `appDMS.handleWebOneEvent` shared by `reopenClosedTab` and the "open path" prompt —
**backfills `item.id` from the uri** (`uri.replaceAll("/", "~ps~")`), as `ext-browse_ss.js` does.
AppDMS derives the id itself only for `FileOpen`/`FileOpenWithCodeEditor`, and the TextViewer branch rewrites the action
to `FileOpen` only afterwards, so an id-less TXT item opens as tab id `"undefined"`;
the SECOND such tab throws a duplicate-widget-id error mid-chain and leaves its uncancelable "Reading &lt;file&gt;…"
modal up for good.
Closed-tab records carry no id, so deriving it is the fix rather than remembering it.

`confirmDropFile` wraps `projects.projectTreeStore.pasteItem` (re-applied from a `createProjectsModel` wrapper, since a
tree refresh recreates the model) and confirms ONCE PER DROP: dijit's `onDndDrop` pastes every dragged node in a single
synchronous `forEach`, so the answer is cached for the rest of the tick and the prompt lists the whole moving set
(the tree's `selectedItems`), capped at 10 lines.

## `openLogInTextTab`

Opens the last submission's log in its own TEXT tab: `tabs._newTab(item)` + `appDMS.createFileView(item, item.tab, text,
paneId)`, the same two calls AppDMS makes, so with the Ace replacement on it lands in the Ace overlay.

Load-bearing details:

- The text comes from the log ENDPOINT (`editor.logURL`, via `fetchLogText`), not the Log pane: past a server-side size
  limit SAS Studio stops streaming chunks into the pane and sends a link instead, so a big run showed a stump.
  Exception, matching SAS's own "open log in a browser tab": with the append-log preference on the pane holds every
  submission and the URL only the last, so that case — and a failed fetch — falls back to the pane.
- Either source is HTML, so it needs rendering to text through `renderedText()`, an offscreen-rendered CLONE.
  `innerText` on the `display:none` pane of an unselected tab degrades to `textContent`, which loses every line break
  (the log's breaks come from its markup, one element per line) and drags the log document's `<style>` in as text;
  the fetched document goes through `DOMParser` first (loads and runs nothing) so its `<style>`/`<link>`/`<script>` can
  be stripped before rendering can restyle SAS Studio.
  `logTextOfTab` is therefore async, and so are `openLogInTextTab`/`refreshLogTab`.
- `fileType: "LOG"` is what makes `createFileView` build the Refresh toolbar.
  The item's `type` is a made-up `"ssextlog"`, which `_newTab` treats as default and `loadPersistedTabs` ignores, so a
  restored session doesn't try to reopen a log that exists nowhere.
- The `*.log` NAME picks the mode via `aceModeFor`, which strips a trailing `" <n>"` since `_incrementTitle` appends a
  counter and the extension would otherwise not be last.
- Refresh re-reads the source tab's Log pane.
  The source is remembered as `__ssfLogSourceTabId`, its BorderContainer's widget id as a STRING — the tab objects are
  JSON-stringified into the user's tab preferences on every change, and an object reference would throw on the cycle
  and silently stop tab persistence.
  `appDMS.onTextRefresh` is wrapped once at init so both the toolbar button and F5 go through it.
- The tab is editable like any other text viewer even though nothing backs it: F5 puts the log back, and
  `saveTextViewer`'s no-uri guard turns a stray Ctrl+S into one error message.

## `minimizeBusyDialog`

Wraps `appDMS.dialogs.postBusyDialog` and, when the created dialog is the foreground-run dialog (a cancel callback was
passed — only the submit paths do), replaces the modal with a non-blocking status-bar indicator.
Non-run busy dialogs like "Reading file" keep stock modal behaviour;
the options-page checkbox is the only config.

It calls `dijit.Dialog._DialogLevelManager.hide(dialog)` to release the shared modal underlay early (safe —
`destroy()` calls the same function again, whose out-of-order branch no-ops), overrides `_position` to a no-op and
`display:none`s the dialog, then tints `#studio_status_bar` amber with `ssf-run-bar` and appends a `#ssf-run-cancel`
chip floated right, wired to the dialog's own cancel callback.
SAS keeps writing live run status into `#status_message`, so the run is signalled without covering the app.

**The bar is simply always there to write into, maximized view included.** Stock `setMaxView` never touches
`#studio_status_bar` — only `headContainer` is ours to reclaim — so neither this patch nor `maximizeEditor` sets
its height.

It also marks the running tab (the focused code tab at run-start) with `ssf-running`, whose `#ssf-run-style` CSS
replaces the tab's file icon with a CSS spinner and tints the tab-title background, so you can see WHICH script is
executing.
That sheet lives inside `@layer ssext-dark` — the layer `src/dark.css` declares.
For `!important` declarations a layer outranks every unlayered one, so outside it neither our stylesheet nor an inline
style could beat dark.css and the run signal vanished in dark mode.
Joining the layer puts plain specificity back in charge, which is also why the tab rules repeat the class
(`.dijitTab.ssf-running.ssf-running.ssf-running`, against dark.css's three-class selectors) and cover the tab's
children, and why the Cancel chip is a `<span role="button">` rather than an `<a>` (link colours come from a nested
layer nothing outranks, and mid-blue on amber is unreadable).
Colours are forced dark on the amber in both modes.
`restoreStatusBar()` and `reenable()` undo it at run end.

### The single-run guard, two layers

Installed at run start, when a code tab — and so a `DMSEditor` class — is guaranteed to exist:

1. A prototype wrap of `submitHandler`/`interactiveSubmitHandler` short-circuits with a yellow ss-ext busy notice
   (`#ssf-busy-notice`, a top-left fixed element — SAS's own toaster truncates longer messages and
   `sendClientNoteMessage` only reaches the hidden log) whenever `appDMS.dialogs.busyDialog` is already non-null.
   Pre-existing tabs' Run button and F3 were wired with `dojo.hitch(this, this.submitHandler)` at tab construction, so
   the wrap only covers tabs created after install, plus the interactive path.
2. So it also `set("disabled", true)`s every not-already-disabled `submitButton`: the original `submitHandler` bails on
   `this.submitButton.get("disabled")`, SAS Studio's own F3 guard, which blocks both click and F3 with no re-wiring.
   Only buttons recorded as disabled-by-us are re-enabled at run end, via run-once instance wraps of the dialog's
   `hide` and `destroy` (success tears down via destroy, the error path via `hide`).

Background submits are deliberately left alone: `backgroundSubmitButton` posts to its own `/submissions` endpoint in a
separate session and SAS Studio supports several at once — only the foreground run is single-run.

Run-in-progress detection is `runActive()` — the run's own dialog, `.open && !._destroyed` — NOT
`dialogs.busyDialog != null`: every run-end path tears down via `submitDialog.hide()`, so that reference stays stale
non-null after every completed run.

### What is blocked during a run

- `dojo.xhr` is wrapped (all `xhrGet`/`xhrPost` delegate to it at call time): a `/workspace/` request fired while the
  busy dialog exists gets a throttled (3 s), non-warn notice saying it's queued until the run finishes.
  Sticky and click-to-dismiss, cleared automatically when the dialog closes — it describes a state true exactly as long
  as the run lasts, so no timeout.
- `appDMS.handleWebOneEvent` is wrapped: while `runActive()`, `"FileOpenWithTextViewer"` (always) and `"FileOpen"` of a
  TXT/LOG/LST file are refused with a warn notice.
  The block must sit at that entry point — the open chain fires SYNCHRONOUS xhrs against the busy session
  (`getModifiedTime`, `sync: true`), freezing the whole JS thread until run end so a notice written just before it does
  not even paint, and the text branch additionally posts an uncancelable "Reading file" modal whose posting destroys the
  minimized run dialog.
  All as-text entry points call `handleWebOneEvent` dynamically at click time, so the instance wrap is never bypassed by
  construction-time hitches;
  `appDMS.perspectiveFileOpen` carries the same check as a backstop.
  SAS-type files take the editor branch and stay allowed (the tab fills at run end).

## `runFocus`

Governs what a run may do to the pane selection.
SAS Studio moves you twice: to the Log pane when the first log line arrives (`updateLog`, while `this.running` is still
true) and to Results / Output data / the Log when it finishes (`submitComplete`, after `running` went false).
Every one of those goes through `DMSEditor.prototype.selectTab` and nothing else does — a chip click,
`selectNextPane`/`focusPaneBar` and SAS's own `setNextFocus` call the dijit container's `selectChild` directly — so one
prototype wrap plus `this.running` expresses all three modes of `chrome.storage.local.runFocus` (`DEFAULT_RUN_FOCUS` =
`"log"`): `"app"` calls through, `"log"` allows only `logContentPane` while running, `"none"` allows nothing.

Which pane got something NEW is deliberately not taken from those suppressed `selectTab` calls — they lie: a data step
that creates a table selects Results (which just got an empty document) and never selects the new Output data pane.
Marking hangs off the two places that only run when there IS new content: `setOutputStates(a, ...)` (SAS's own
"did this produce output?" branch, `a` being `submitComplete`'s `NoOutputGenerated` flag, whose no-output
branch also drops a stale mark) and `createDataTab`.
The Log is never marked — it streams throughout the run, so an outline on it says nothing.

`markPaneUpdated` skips `"app"` mode and any pane already on screen — its own container's `selectedChildWidget`, NOT
`editorTab.selectedTab`: that is a single value, but a SPLIT layout shows one pane per strip, so a pane visible in a
side strip was outlined with no way to clear it.
The mark is a `ssf-pane-updated` class on the pane's `controlButton.domNode` for a sticky `outline` (not a border, so
the chip doesn't shift) plus a WAAPI `node.animate()` blink — re-running the animation on a chip that already has the
outline blinks it again, with no class/reflow restart dance.

Completion also moves the KEYBOARD without going through `selectTab`, so two more wraps: `setNextFocus` no-ops outside
`"app"`, and `submitComplete` swaps the instance's `focus` for a no-op until its own 250 ms timeout has fired.

Clearing the mark hangs off `dijit/layout/StackContainer.prototype._transition`, and it has to be that method.
`DMSEditor`'s constructor `dojo.connect`s `sasSuiteTabContainer`'s `selectChild`, and dojo/aspect implements that by
writing an OWN `selectChild` whose around-advice holds the prototype function **as captured at that moment** — so every
tab constructed before the patch (the startup blank editor, every restored tab) calls the pristine function forever and
a prototype wrap on `selectChild` is never reached;
wrapping `onTabSelect` fails the same way one level down.
`_transition` is the one thing on that path SAS never connects to, and the pristine `selectChild` reaches it through the
prototype at call time.

`runFocusMode()` reads `window.__ssf.runFocus` on every call, which is the whole live-apply — `sw.js`'s storage listener
just assigns to it.
The patch has no `SSF_TOOLS` entry, so no checkbox is rendered and it always applies;
the three-way select lives in the options page's Patches section.
The `DMSEditor` class comes from `window.require("webdms/DMSEditor")` (dojo's sync AMD form), not a tab walk, since no
code tab need exist at patch time.

## Other traps

Some SAS Studio methods are subtly broken by the app itself — e.g. `dijit.Tree._expandNode` is overridden to return
undefined, and `ss-fixes.js` re-binds the prototype original.
