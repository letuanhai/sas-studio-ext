# Extension shell — service worker, relay, pages, dark mode

## `src/sw.js`

Six jobs.
No `chrome.commands` handler: the editor toggle / native-mouse toggle / browse / command palette are all in-page
`ss-fixes.js` actions with rebindable hotkeys (editor toggle defaults to `Ctrl+.`), plus the popup's buttons.
The only browser command is `_execute_action`, which Chrome itself handles to open the popup, unbound by default.

In-page editor toggles post `{ __ssextBadge }` → `relay.js` → a `chrome.runtime.onMessage` listener here that sets the
per-tab `ON`/`OFF` badge (MAIN-world code can't call `chrome.action`;
the popup sets its own badge directly).

1. **ss-fixes injection** — on every `tabs.onUpdated` for a `/SASStudio/` URL: inject `tools-meta.js` + `ss-fixes.js`
   into the MAIN world, pre-inject `editor-swap.js` (+ `ace-patches.js`), seed
   `window.__ssExt.libPath`/`userSnippets`/`aceConfig`/`browsePaths`/`diffPrefs`, and only THEN call
   `window.__ssf.init(settings)` with the persisted patch/hotkey/`keyLayout` settings.
   That order is what gives the global palette/browse hotkeys, any editor created on that page load, and the
   `aceEditorOnLoad` patch what they need.
2. **Live snippet apply** — on `snippets` changing, merge over `DEFAULT_SNIPPETS` and push the whole scope → text map
   into every open tab via `__ssExt.applySnippets`.
3. **Live ace-config apply** — on `aceConfig` changing (written by options.html or, via `relay.js`, by the in-page
   settings panel), merge over `DEFAULT_ACE_CONFIG` and push via `__ssExt.applyAceConfig`.
4. **Live browse-prompt apply** — on `browseKeys` or `browseFileActions` changing, assign to every open tab (neither is
   host-scoped: which key does what, and what an extension opens as, are not properties of the server).
   On `browsePaths` changing, assign each tab its own host's entry — no apply function needed, `ext-browse_ss.js` reads
   it when a prompt opens.
5. **Live run-focus apply** — on `runFocus` changing, assign to every tab's `window.__ssf.runFocus`;
   the patch reads it on every `selectTab`.
6. **Dark mode** — see below.

## `src/relay.js`

ISOLATED-world content script (`*://*/SASStudio/*`, declared in `manifest.json`), the only bridge from MAIN-world code
to `chrome.storage`.
Listens for source-checked `window.postMessage` of `__ssextAceConfig` / `__ssextDiffPrefs` / the browse_ss store keys /
`__ssextBadge` and writes them.
Nothing else.

## `src/tools-meta.js`

Plain script (no modules), loaded both as an extension-page `<script>` and injected into the MAIN world alongside
`ss-fixes.js`.

- `SSF_TOOLS` — `{name, kind, label, title, hotkey, defaultOff?}`, one entry per `ss-fixes.js` action/patch.
- `SSF_BROWSE_KEYS` — `{name, label, keys, legend?, history?}`, one per browse-prompt binding.
  `keys` is an ace key string like `Alt-Shift-C`, not a keymap object, because `ext-browse_ss.js` binds them on its own
  command line;
  `history: true` entries only exist in the browsers that have a history key.
- `SSF_BROWSE_FILE_ACTIONS` — `{name, label, tool}`, the four things a plain Enter can be redirected to per file
  extension (`open`/`text`/`reveal`/`download`), each a mode `accept()` understands and each with a key of its own.
  `open` is the one that asks for SAS Studio's own handling BACK, unlisted extensions being revealed.
- `ssfBrowseKeys(tool, browseKeys)` — stored override wins, including `""` for a deliberate unbind.
- `ssfBrowseFileAction(path, actions)` — extension lower-cased and dot-less, looked up in the stored map;
  `""` for no extension, a dotfile, or an unlisted one.
- `ssfBrowseKeyLabel(keys)` — `Alt-Shift-C` → `Alt+Shift+C`, first alternative only.
- `ssfPatchEnabled(tool, fixes)` — patches are enabled unless stored `false`, except `defaultOff: true` ones (currently
  only `aceEditorOnLoad`), which are disabled unless stored `true`.
- `ssfEventKey(event)` — **with Alt held, returns the physical key for `event.code` instead of `event.key`**.
  macOS composes Option+n/Option+. into `"Dead"`/`"≥"`, which would otherwise make Alt hotkeys unrecordable and
  unmatchable.
  Resolution order: `window.ssfKeyLayout` (the real `navigator.keyboard.getLayoutMap()` result), then a small US-layout
  punctuation table, then the letter/digit in the code name itself (`KeyN`→`n`).
  Lower-cased, and hotkey matching is case-insensitive so the uppercase `SSF_TOOLS` defaults still match.
  `getLayoutMap()` is **secure-context only**, so the plain-http page can't call it: `ssfLoadKeyLayout()` runs on the
  options page (a `chrome-extension:` page, so secure), fills `ssfKeyLayout` and persists it to
  `chrome.storage.local.keyLayout`, which `sw.js` passes in `init(settings)`.
  Both sides therefore agree on non-US layouts once the options page has been opened once.

## `src/defaults.js`

Loaded via `importScripts()` in `sw.js` and a `<script>` tag in `options.html`.

- `DEFAULT_BROWSE_FILE_ACTIONS` — `{ sas: "open", log/lst/txt/lua: "text" }`, what Enter does in the FILE browser per
  extension.
  Since anything unlisted is REVEALED, this map is the list of extensions worth OPENING and is meant to be edited;
  `sas` has to be in it or the browser's main job stops working.
  **A stored map REPLACES this one rather than merging**, which is what makes a default entry removable — same reason
  `vimrc` works that way, hence the options page's single "Restore defaults" button.
- `DEFAULT_SNIPPETS` — `{ sas: DEFAULT_SAS_SNIPPETS }`, a map of ace snippet scope → snippet file text.
  Merged per key (a stored language wins even when empty), so a language with no default doesn't need an entry here to
  be configurable.
- `DEFAULT_ACE_CONFIG` — `{ darkTheme, lightTheme, options: {...}, vimrc: "", lsp: true, lspMaxLines: 500 }`.
  Storage wins per key, shallow merge of the top level and of `options`;
  `vimrc` merged with a `typeof stored.vimrc === "string"` check and `lspMaxLines` with a `typeof === "number"` one, so
  a cleared value wins over the default.
- `DEFAULT_DARK_MODE` — `"off"`.
  Dark mode is opt-in, and `"off"`/`"system"` both leave Ace following the OS, so enabling the feature never takes an
  OS-dark editor away from anyone.
- `DEFAULT_RUN_FOCUS` (`"log"`), `DEFAULT_DIFF_PREFS`.

## `src/popup.html` / `popup.js`

`action.default_popup`: the editor toggle, the native-mouse toggle, a "Command palette…" button, the per-host
"Browse roots" inputs, and a link to the options page.
The per-action buttons this popup used to render live in the command palette instead.
The palette button files-injects `editor-swap.js` (idempotent) then calls `__ssExt.commandPalette(libPath)` and closes.

Browse roots are persisted as `chrome.storage.local.browsePaths` keyed BY HOST (`{ "<host>": { files, library } }`) —
root paths name folders on one specific server, the same reason the browse history and bookmarks are host-keyed.
The popup owns this UI rather than the options page precisely because it is already scoped to the active tab, so the
host needs no typing;
it saves on every keystroke, the popup being dismissible without a blur or change event.

## `src/options.html` / `options.js`

All configuration.
Patch and hotkey changes apply on next page reload;
snippet and editor-config changes apply immediately.

- **Appearance** — the dark-mode select (`darkMode`), a three-way "Pane focus on run" select (`runFocus`), and a
  checkbox per patch (`fixes`).
- **Hotkeys** — a table with per-action record/clear (`hotkeys`), rendered after `ssfLoadKeyLayout()` resolves, since
  recording needs the layout map.
- **Browse keys** — a second table (`browseKeys`) with record/clear/**default**.
  Recording converts the event to an ace key string via `ace/lib/keys`' `keyCodeToString`, and refuses a modifier-less
  non-function key, because ace's `MultiHashHandler` would parse that as a TEXT binding that fires while typing a path.
- **File browser config** — what Enter does per file type (`browseFileActions`): one comma-separated extension list per
  action, saved on `change`, grouped on render and flattened back to the `extension → action` map.
  A leading dot is stripped;
  an extension named in two rows takes the last.
  One "Restore defaults" button rather than per-row resets, since the stored map replaces the default outright.
- **Editor** — dark/light theme selects populated from `ace/ext/themelist`, the "SAS language server" and "Lua language
  server" checkboxes, a number input for `lspMaxLines` (0 = no limit), and a "Vim config" textarea with an explicit Save
  button plus a static note listing the custom ex-commands.
  Everything else, the keyboard handler included, is configured from Ace's own stock settings menu and persists through
  the same `OptionPanel.prototype.setOption` hook `editor-swap.js` installs (here writing straight to storage).

### The snippet editor

An Ace-backed text box (`chrome.storage.local.snippets`, live-applied on Save by `sw.js`) that also consumes
`aceConfig` (theme pair + `setOptions` + vimrc, with its own copy of `applyVimrcLine`).

It holds ONE language at a time, picked by a select built from `ace/ext/modelist` — so the list is whatever ace can
highlight, our own SAS/SAS Log entries included, with no second hardcoded language list to keep in step — keyed by the
mode id's last segment, i.e. the snippet scope `applySnippets` registers against.

The editor always uses `ace/mode/snippets`, so every scope gets snippet-file syntax highlighting rather than treating
the body as a program;
the select chooses only the registration scope.
Consequence: a user template defined under the **Snippets** language stays available in the box whatever target language
is selected.
`useWorker` is off explicitly, so choosing a program mode temporarily through the settings menu cannot start its
syntax-check worker against snippet-file syntax.

Completion is an explicit two-provider list — `snippetCompleter` (ace's own templates for authoring snippet files) and
`textCompleter` (words in the current file) — with no target-language keyword completer.
`initSnippets()` also parses and registers the saved scope into that snippet manager on page load, when leaving that
scope in the select (a local preview of the unsaved draft), and after every Save, unregistering the previous set first.

**Switching language neither writes nor discards anything**: every language's text stays in memory for the page's
lifetime and one Save writes them all.
What a switch DOES drop, deliberately, is the undo history: one session holds every language in turn, so the `setValue`
that swaps the text is itself an undoable delta, and a single Ctrl+Z restored the PREVIOUS language's file into the box
— which the change handler then kept as this language's draft and Save persisted.
So `show()` `reset()`s the session's undo manager after the swap.

The select says which is which: `*` marks unsaved edits, `•` a language that has snippets — as a SUFFIX, since a
`<select>`'s type-ahead prefix-matches the option TEXT and with ~200 languages typing the caption is the only practical
way to reach one.
A language emptied out is saved as `""` when it has a default (otherwise the default comes straight back) and dropped
when it doesn't.

Three limitations, none of them new code's doing.
Two are ace's own snippet manager, pre-existing but now N languages wide: a snippet with no `snippet <name>` line can
never be unregistered (so a re-apply leaks a copy), and a user snippet whose name collides with a built-in destroys that
built-in until reload — likelier now that `if`/`for`/`fn` can be written per language.
The third is ace's `$getScope`, which collapses `php` onto `html` and answers `javascript`/`css` inside an HTML
document, so a set saved under some of the 193 scopes can never fire.

`options.js` also sets the `ace.config.setModuleUrl` overrides for the four keyboard-handler modules (same fix as
`loadNewAce`), and listens to `chrome.storage.onChanged` for `aceConfig` with an `applying` re-entrancy guard so its own
writes don't bounce back.

## `src/changelog.html` / `changelog.js`

A second extension page, reached from the last pill in the options page's `#toc` nav and back again, so the changelog
doesn't add an eighth section to an already long options page.
`changelog.js` `fetch`es the shipped `../CHANGELOG.md` (extension-own origin, no `web_accessible_resources` needed) and
renders it with a ~30-line parser that knows only what that file uses — `##` headings, `-` bullets with wrapped
continuation lines, paragraphs, inline `` `code` ``/`**bold**` — so nothing is duplicated by hand.
Its nav is a sticky column of plain version links down the LEFT, built from the `##` headings it just parsed, so a
release adds its link for free.

**Entries in `CHANGELOG.md` are summaries of at most 3 lines**;
the reasoning and measurements live in the commit history.

## `src/page.css`

The palette (`--bg`/`--fg`/… custom properties, light-scheme overrides), page frame and sticky `#toc` bar shared by
`options.html` and `changelog.html`.
Page-specific rules stay in a `<style>` block in the page that needs them.

## Dark mode

### `sw.js`'s `syncDarkInjection(mode)`

Registers (or unregisters) a content script with id `ssext-dark` at `document_start` over `*://*/SASStudio/*`,
`persistAcrossSessions` — `["src/dark-inject.js"]` for `"on"`, `["src/dark-media-auto.js", "src/dark-inject.js"]` for
`"system"`, nothing for `"off"`.
(`dark-media-auto.js` is one line setting `__ssextDarkMedia`, read by `dark-inject.js` — content scripts in one
registration share an isolated world and run in order.)

**`dark-inject.js` attaches `src/dark.css` as a `<link>` node it creates, NOT as a registered `css:` entry**, and that
distinction is the whole design.
Extension-injected CSS lands in a separate injection origin that is neither in the page's `document.styleSheets` nor
removable by `chrome.scripting.removeCSS` (which only tracks `insertCSS`'d sheets), so once in it could never be taken
out and turning dark mode off needed a reload.
A `<link>` is an ordinary DOM node, so `applyDarkToTab(tabId, mode)` can add/replace/remove it in any open tab and every
transition is live — on, off, and on↔system — with Ace re-themed in the same pass so the editor and app chrome never
disagree.
(This is how Dark Reader itself toggles live.) `"system"` is the `media` attribute on that link, which is why there is
only ever ONE copy of the stylesheet.

Appended to `documentElement`, since at `document_start` `<head>` may not exist yet.
A stylesheet in the document blocks rendering until it loads and this one is a local extension resource, so **the first
paint is already dark** — 0 light frames in 157 across a 6.3 s load, against a dark-mode-off control showing 22.

### `src/dark.css`

The static dark theme for SAS Studio's own UI, ~460 KB, generated by `tools/gen-dark-css.js` and **committed** —
regenerating needs a live SAS Studio instance, so a release must not depend on it.
Don't hand-edit;
change the generator and re-run.
Listed in `web_accessible_resources` because the page loads it through a `<link>`.
It declares the `ssext-dark` cascade layer that `ss-fixes.js`'s run-status sheet joins.

Ace is deliberately untouched (every `ace_` rule is stripped) — it themes itself, and `prefersDarkTheme()` in
`editor-swap.js` keeps the two in step.

### `tools/gen-dark-css.js`

Loads the live instance, runs Dark Reader (pinned, fetched via `npm pack`, dev-time only — never vendored, never
shipped) with `ignoreImageAnalysis: ["*"]`, and `exportGeneratedCSS()`s the palette.
Dark Reader is used for the palette ONLY;
its runtime is exactly what we're avoiding — see the file header for the measurements.

Four post-processing steps, each from a bug that actually happened:

1. Strip every `ace_` rule.
2. Drop every `background-image: url(...)` declaration.
   Dark Reader's export mixes absolute URLs (baked to whatever host it ran against) with relative ones (relative to the
   sheet they came from, which resolve against the page root in our sheet, so `.dijitTreeIcon` 404'd).
   Dropping the declaration lets SAS Studio's own rule apply, correctly resolved.
3. Mark colour declarations `!important` (an allowlist — `background-color`, `color`, `border-*-color`, `box-shadow`,
…).
   Chrome injects content-script CSS into the author origin but BEFORE the page's stylesheets, so a same-specificity
   rule loses every tie: without this, `html`'s background went dark (that rule already had `!important`) and `body`'s
   didn't.
   Deliberately NOT applied to `border-width`/`border-style`/`background-size`/`background-repeat`, which would start
   overriding the inline layout styles Dojo writes on its widgets.
4. Emit the icon rule.
   SAS ships BOTH dark artwork (`sasIcons/sasdark/*`, for a light background) and light artwork (`sasIcons/saslight/*`,
   already for the dark blue banner), so it measures each image's mean luminance on a canvas and inverts only the dark
   ones — a blanket invert turned the banner's white glyphs into black blobs.
   **The walk MUST run before `DarkReader.enable()`**: afterwards it reads Dark Reader's rewritten sheets, every image
   fails to load, and everything silently measures "not dark" (there's a guard that throws if zero dark icons are
   found).
   Note `rule.style.backgroundImage` returns the url as AUTHORED — only `getComputedStyle` resolves — so it resolves
   against the owning sheet's `href` itself.

Plus a small hand-written block for backgrounds SAS hard-codes as inline styles from its own JS (the busy dialog's
content area does `style="background: white"`), which no static sheet can see;
a sweep across the main view, the expanded tree and an open dialog found exactly one such patch.
