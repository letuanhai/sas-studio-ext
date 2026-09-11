# Language servers

Two servers run in the page, both driven from `src/editor-swap.js`:

- **SAS** — sassoftware/vscode-sas-extension, built to `lib/sas-lsp/sas-server.js` (~22 MB `target: webworker`).
- **Lua** — emmylua-analyzer-rust, built to `lib/emmylua-lsp/emmylua_ls.wasm`, driven by `src/emmylua-worker.js`.

Both go through `lib/ace-linters/` 2.2.0, which supplies diagnostics, hover, signature help, document highlights, code
actions, semantic tokens, completion + resolve and `format()` with no UI code here.
Definition, references, rename and the whole PROC LUA side channel are built here, ace-linters implementing none of
them.
Not covered at all: symbols, folding, inlay hints, code lens, colour, links, call hierarchy.

Both bundles are gitignored;
`ensureLsp()`/`ensureLuaLinters()` warn once and leave the editor as it was if missing.

## `ensureLsp()` — the SAS server

One shared `LanguageProvider` per page, memoized on `ssExt._lspStarting` (a failure sets `_lspFailed`, never retried
until reload).
Returns `null` when `getAceConfig().lsp === false`.
Otherwise: derive the extension root from `ssExt.libPath`, `HEAD`-probe the bundle, load ace-linters' two UMD files as
classic scripts, construct the worker, call
`AceLanguageClient.for(serverData, { functionality: { completion: { overwriteCompleters: false }, semanticTokens: true } })`.

Two constraints on that:

- **`window.define` is deleted around the UMD load.** Dojo's AMD loader satisfies the wrapper's `define.amd` check and
  would register the module into Dojo's registry instead of setting `window.LanguageClient`/`AceLanguageClient`.
- **The worker is `new Worker(URL.createObjectURL(new Blob(["importScripts(...)"])))`**, not a fetched string, so the
  ~22 MB bundle is never held in memory as JS source.

### `sas/getLibList`

`serverData` carries `initializationOptions: { supportSASGetLibList: true }`.
Without it the server never calls `setLibService` and library/table names are absent from completion.
With it, it sends a CLIENT-bound `sas/getLibList` request (`{ libId }` — `null` lists libraries, otherwise that
library's members) and expects `LibCompleteItem[]`.

ace-linters can't register an inbound request handler, and its own connection would answer `MethodNotFound` first, so
the `onmessage` shim answers it and does **not** forward the message.
`getLibList(libId)` reads `appDMS.libraries.treeModel.query("libraries" | "libraries~<LIB>")` — the source
`ext-browse_ss.js` browses, whose child ids come back in that `~` form, so a library's id round-trips straight back as
the next `libId`.
Memoized in `libListCache`;
a failure is never cached, and a missing `treeModel` resolves `[]` rather than leaving the request hanging.

`installLibListInvalidation()` wraps `appDMS.libraries.onRefresh` **and** `refreshTree` to clear that cache and the
column caches.
Between them they cover every run end, every add/delete/rename, the Refresh button and session reset — no TTL, no stale
window, no polling.
`onRefresh` self-gates on `treeViewActive`, which is why both are wrapped rather than relying on one reaching the other.

### Two workarounds that cost every completion when wrong

1. ace-linters' `filterByFeature` checks `capabilities.hoverProvider == true` and the SAS server advertises the object
   form, so hover never fires.
   An `Object.defineProperty(worker, "onmessage", ...)` shim coerces object-form
   `hoverProvider`/`documentHighlightProvider` to `true` in the initialize response and sets `ssExt._lspReady`.
   An `addEventListener` wrapper sees the message too late.
2. With `overwriteCompleters: false` ace's own completers stay registered and the popup sorts by score, so each default
   completer's `getCompletions` is wrapped to subtract `1e6`.
   That wrap must skip `completer.id === "lspCompleters"` (dampening ace-linters' own shifts everything equally and
   leaves LSP items, which score 0, below the text completer), and `_maybeRegisterLsp` must give the editor its own
   filtered COPY of `editor.completers` before `registerEditor` — otherwise that push lands in the shared array
   `ext-language_tools` hands every editor, leaking one stale LSP completer per registration.

### Completion meta labels

The SAS server kinds every item `Folder` for a library and `Keyword` for everything else — tables, data set names
parsed out of the program, plain keywords — and ace-linters turns the kind straight into the popup's right-hand column.

`installLspMetaLabels(editor)` patches that completer's `getCompletions` **in place**, not as a wrapping copy:
ace-linters keeps finding the object by id (`setServerCapabilities` assigns `triggerCharacters` onto it).
`relabelLspCompletions` rewrites the meta where it can tell what an entry is: `Folder` → `library`;
a `Keyword` that is a known table of the libref typed before the caret → `SASHELP.`;
a `Keyword` in a response that ALSO lists libraries → `program`, that being the one response where the server mixes the
program's own data set names in.

The same wrapper calls `pinMacroRanges`, which stops macro completion inserting a second `%`: the server labels macro
FUNCTIONS with the `%` included (`%LENGTH`) while ace's prefix stops at the sigil, so those entries get an explicit
`range` over it (which `insertMatch` turns into `replaceBefore`).
Widening ace's identifier regexp instead would break the bare-`&` macro variables the same way.

### Registration and eligibility

`AceEditorAdapter`'s constructor calls `_maybeRegisterLsp()`, gated on `_lspEligible()`: mode is `ace/mode/sas` or
`ace/mode/lua`, and `aceConfig.lspMaxLines <= 0` or the session is within it (default 500).
It then calls the right `ensure*` as a fire-and-forget `.then`, guarded by `_lspRegistering`, re-checks eligibility
inside the `.then` (a big `setText()` may have landed) and by `this._disposed`, remembers which provider took it
(`this._lspProvider`), and schedules a 2-second semantic-token kick, the initial request racing the server's `didOpen`.

`setText()` re-runs the check: over the limit now → `_unregisterLsp()`;
eligible now → re-enter.
`_unregisterLsp()` is the one funnel, shared with `dispose()` and the mode switch.
ponytail: typing growth past the limit isn't monitored — a reload or another `setText` picks it up.

**A mode change moves the editor between the two servers**, ace's settings pane and a Save As under a new extension both
changing a live session's mode.
`setupAceEventBindings()` listens for `changeMode` → `_syncLspToMode()` → update `_resolvedMode`, unregister,
re-register.
Leaving this to ace-linters does not work: its own `changeMode` only re-resolves services inside the shared
`ServiceManager`, so with no Lua service registered there the document stays on the SAS service under its `.sas` uri.
`_maybeRegisterLsp()` captures the mode it started for and re-enters if `_resolvedMode` changed while the server was
starting (the racing `_syncLspToMode()` having bailed on `_lspRegistering`);
the token kick checks `_lspProvider !== provider` for the same reason.

The worker and provider live for the page's lifetime once started;
toggling Ace off and on just re-registers editors.

### `installLspMarkerPatches(provider, session)`

Once per page, after the first successful `registerEditor`, on the prototype of ace-linters' `SessionLanguageProvider`.
Three patches exist because the SAS server answers `semanticTokens/full` for the WHOLE document on every edit and every
scroll:

1. `setSemanticTokenMarkers` filters the token set to the viewport ± `SEMANTIC_TOKEN_MARGIN` (50) rows before
   ace-linters turns each token into a text marker.
   Only rendered rows can show one, yet `$applyTextMarkers` walks the whole set on EVERY render.
2. The same wrapper resets `session.$textMarkers`/`$textMarkerId` once the store is longer than 4096 and empty of live
   markers.
   ace-linters indexes that array by an ever-growing id while `removeTextMarker` only `delete`s from it, so it grows
   without bound and every render `forEach`es over it.
3. `getSemanticTokens` gets a 60 ms trailing debounce, ace-linters requesting a fresh set from every `changeScrollTop`.

The fourth is about colour: `toAceTokenClassName` routes the token type through `themedSemanticScope()`.
ace-linters maps an LSP token type to a TextMate-ish scope (`method` → `entity.name.function.member`) and that scope
into the marker's class list, but ace themes style only a handful of scopes — gruvbox has
`keyword`/`comment`/`variable`/`constant`/`string`/`support`/`storage` — so most semantic markers carry a class no rule
matches and the text keeps the mode tokenizer's colour.
`SEMANTIC_SCOPE_ALIASES` rewrites the leading segments onto scopes themes do paint, longest prefix first, modifiers
riding along;
unknown and already-styled scopes pass through.
Both providers share the prototype, so it applies to both.

Which scopes a theme paints still varies, and some paint fewer than they look like they do (ace-chrome's
`.ace_support.ace_class` rule has a missing comma, degrading the selector to a descendant combinator).
So the same wrapper calls `ensureSemanticFallback(editor)`: probe the live theme once per `theme.cssClass` with a hidden
editor div and one throwaway `<span>` per scope, then emit a `:where(.<theme>) :where(...) { color: … }` rule per scope
it finds unpainted, borrowing from `SEMANTIC_SCOPE_DONORS`, else the nearest painted ANCESTOR (`support.type.enum` →
`support.type` → `support`), else a generic donor.
`:where()` keeps it at zero specificity, so a theme that does style the scope always wins and the probe never has to
decide who is right.

`SEMANTIC_SCOPE_DONORS` has one entry and it is the point of the exercise: `support.class`/`.namespace` borrow
`constant.library`, which is what ace's lua mode paints `os` with, so `sas` comes out the same green rather than merely
SOME colour.
It has to be that donor — the marker span is a CHILD of the mode's token span and wins over it, so any other choice
recolours `os` while fixing `sas`.

## `ensureLuaLinters()` — the Lua server

For `.lua` files opened as text.
Such a session is one language end to end (`aceModeFor` resolves the name through ext/modelist, so the adapter is built
with `ace/mode/lua`), which is ace-linters' own case.

Memoized on `_luaLintersStarting`, `HEAD`-probes the wasm, starts
`src/emmylua-worker.js` in a blob + `importScripts` worker (a worker created from a `chrome-extension:` URL is at the
mercy of the page's `worker-src`), builds a second provider (`modes: "lua"`, same options).

### Two providers share one registry, and both halves need naming apart

`AceLanguageClient.for()` keeps a module-level `ServiceManager` and a single `MockWorker` pair for the whole page, so
the second call registers into the first one's manager.

1. `$services` is keyed by `serverData.serviceName ?? "server"`.
   Unnamed, the Lua server simply REPLACED the SAS one and every SAS request started answering `undefined` as soon as a
   `.lua` file was opened.
   Hence explicit `serviceName: "sas"`/`"lua"`.
2. Both `MessageController`s post to and listen on that one `MockWorker` while each numbers its callbacks from 1, so a
   Lua reply could consume a SAS callback wherever the counters overlapped.
   `shareLspCallbackIds(provider)` redefines `callbackId` as an accessor over one page-wide counter;
   `this.callbackId++` reads then writes, so the setter ignores its argument and just advances the shared value.

### Document URIs

For the Lua provider, `_maybeRegisterLsp` passes `registerEditor`'s second argument `{ filePath }` (the adapter's
optional 4th constructor argument, `item.uri` from the `createFileView` wrapper).
That becomes the LSP document's URI instead of ace-linters' `file:///<ace session id>.lua`, and a real path is what lets
the server derive a module name — the whole of why `require()` of another open `.lua` tab resolves.

An editor with no file of its own (a code tab switched to lua mode, a scratch buffer) gets `/ssext-scratch/<session
id>.lua`.
A document under no workspace root is not a module, and `require()`'s visibility check needs the REQUIRING file to be
one: `check_module_visibility` asks `get_workspace_id(file)`, answered only for files in the module index, and
`.unwrap_or(false)` turns the miss into ``module '<x>' visibility is not `public` ``.
`/ssext-scratch` is deliberately not under `/ssext/`, the prefix `rootOf()` skips so the `sas.lua` defs never become
requireable.
Not done for the SAS provider, which has no module concept and whose documents are keyed by session id.

### Formatting

`formatDocument` (`Ctrl-Shift-F`) is an ace command on the adapter — ace-linters exposes `format()` but binds nothing —
so it is a command-palette entry for free, and says so through `window.__ssf.notify` when no provider is registered.

It does **not** call `provider.format()`, which is off by one and formats nothing: it builds the whole-document range as
row 0 .. `session.getLength()` (the line COUNT, one past the last row) at column `getLine(thatRow).length - 1`, i.e. -1,
and the server answers `null`.
`formatWithLsp(provider, editor)` makes the same `$sendDeltaQueue` + `$messageController.format` calls with the range it
meant, and formats a non-empty selection instead of the file.

## PROC LUA `submit;`…`endsubmit;` blocks

That Lua lives in an `ace/mode/sas` session.
ace-linters serves a session as ONE language and the session belongs to the SAS server, so the Lua provider can never be
given it.
Everything here goes over `ssExt._luaRaw`.

The document handed to emmylua is the SAS file with every **non-Lua LINE blanked out** (`blankNonLua`), and that is the
whole of the position handling: an LSP line/character is an ace row/column unchanged in both directions, so nothing is
ever translated and the Lua the server sees is exactly the Lua the user wrote.

`luaRanges(lines)` is the block finder: a three-state line scan where the fence lines themselves are SAS (so the body is
the rows between them), an unclosed block runs to the end of the file (you are typing inside it), and `\bsubmit\b`
cannot match inside `endsubmit`, which is what lets one scan test for both.

One document per session (`file:///ssext-scratch/<session id>-proclua.lua`), synced 400 ms after the last edit and once
from the constructor (content passed at construction fires no `change` event), closed when the block is deleted or the
tab goes.
Nothing starts the server until a file actually HAS a block, and `sessionLuaRanges` honours `aceConfig.lspMaxLines` —
this pushes the whole file on every edit, which is what that limit is for.
`sessionLuaRanges` is also the single gate for `aceConfig.procLuaLsp` (off by default):
anything but `true` returns no ranges, which takes the sync, the completer, the hover and the formatter with it, and makes the next
`syncProcLuaDoc` close the open document and clear its diagnostics.
The two flags are independent — `luaLsp` is the `.lua`-file path only (checked in `_lspEligible`), `procLuaLsp` the
blocks — but they share the one worker, so whichever comes first starts it.

The surfaces, all wired by hand since no ace-linters session owns any of this:

| Surface | How |
|---|---|
| Completion | one completer, `ssextProcLua`, score 2000 (above the SAS context completer's 1000), declining outside a block |
| Hover | `doHover` wrap on the **SAS** provider: `sasFnHover`, then emmylua, then the SAS server's own answer |
| Diagnostics | a `setAnnotations` wrapper that re-appends ours, the SAS provider replacing the whole set each validation |
| Semantic tokens | decoded here, added through `session.addTextMarker` + the patched `toAceTokenClassName` |
| Signature help | `provideSignatureHelp` wrap, ace-linters' `SignatureTooltip` already being attached |
| Occurrence highlights | a wrap on the message CONTROLLER, feeding ace-linters' own callback |
| Formatting | `textDocument/rangeFormatting` over the block's rows |

Details that are not obvious from that table:

- **Semantic tokens.** `decodeSemanticTokens` is the LSP wire format (five ints per token, first two delta-encoded) plus
  a copy of ace-linters' bundle-internal `toAceTokenType` scope table — matching it is the point, since the two
  mechanisms then produce identical classes.
  The legend comes from the initialize result, kept by the channel's `intercept` because a `.sas` file has no registered
  Lua session to read it off.
  The token set is remembered on the session: the marker-store compaction above needs the store empty of live markers,
  and ours would block it forever, so it drops them, resets, and `reapplyProcLuaTokens` puts them back.
  No viewport filter — a submit block is a handful of rows.
- **Occurrence highlights** have no provider method to wrap: ace-linters drives them from its own `changeSelection`
  timer in `registerEditor` and hands the answer to an instance arrow function.
  So `installProcLuaHighlights` wraps `$messageController.findDocumentHighlights` (whose
  `comboDocumentIdentifier.sessionId` is the ace session id, which is what `procLuaDocs` is keyed by).
  It REPLACES the SAS request rather than running beside it, both writing the one `MarkerGroup`, and answers `[]` rather
  than `null` on an empty result — `$applyDocumentHighlight` ignores a null and would leave the previous caret's markers
  up.
- **Formatting** needs the range form, `formatDocument` otherwise reaching the SAS provider, which would format the
  whole file AS SAS.
  The blanking then forces two things: the edits are re-indented (`reindentEdits` over `blockIndent`'s smallest leading
  run, the server seeing that Lua as top-level and returning it flush at column 0), and the row filter accepts an end of
  `(to + 1, 0)`, which is how a whole-block format states "through the end of the last row".
  `applyProcLuaEdits` applies LAST FIRST, every LSP range being stated against the document as it was.

Snippets caveat: a submit block is an `ace/mode/sas` session, so it gets SAS's snippets, not Lua's.

### `initLuaService`

`AceLanguageClient.for()` only REGISTERS a service.
ace-linters constructs the `LanguageClient` — and sends `initialize` — lazily, the first time a document of that mode is
added, which normally happens when a `.lua` editor registers.
A `.sas` file with a block never registers one, so without this the server sits uninitialized and every side-channel
request times out to `null`: no diagnostics, hover, completion, highlights or formatting for a block on any page with no
`.lua` tab open, i.e. every ordinary `.sas` file.

The fix is one empty scratch document through ace-linters' own `$messageController.init`.
It goes under `/ssext/` (the prefix the worker skips when deriving roots) so it never becomes a requireable module, and
a `publishDiagnostics` for a uri with no ace session is dropped by ace-linters itself.
Its identifier must name `documentUri`/`sessionId`, not `uri` — `BaseMessage` reads exactly those two, and a missing
`documentUri` defaults to `""`, opening the document under the empty uri.

**`test/smoke.js` runs its PROC LUA block BEFORE its `.lua` block, and that order is the regression guard** — a `.lua`
editor registering is what warms the server up, which hid this entirely.

## Definition, references and rename

The one Lua feature set spanning both kinds of editor.
A `.lua` tab and a PROC LUA block differ in nothing but which document uri the caret resolves to, so `luaDocAt(adapter,
pos)` answers that one question — the block's blanked document if the caret is inside one, else the `.lua` document
ace-linters registered — and everything downstream is shared.
All of it goes down `ssExt._luaRaw`;
`_lspRaw` is not involved, the SAS server having none of these features.

Four ace COMMANDS carry them (`gotoDefinition`, `findReferences`, `renameSymbol`, `gotoLastJump`), registered on every
adapter like the diff commands, so ace's settings menu binds them and a vimrc maps them (`nmap gd <Cmd>gotoDefinition`).
**None has a default keybinding**: F12 is the browser's, F2 is ace's `toggleFoldWidget`, `Alt-Left` is its
`gotolinestart`, and `ss-fixes.js` binds Alt+letter globally in the capture phase.
The palette lists them whenever an editor is focused, which costs nothing.
The three server-backed ones report "no Lua language server for this position" rather than declining through
`isAvailable` — a command missing from the palette is indistinguishable from one that is broken.

- `firstLspLocation` normalises what `textDocument/definition` may answer: emmylua sends a bare `Location` for a
  same-document hit and an ARRAY for a cross-file one, and `LocationLink` is handled too, at the cost of one line,
  because it is the third thing the spec permits.
- `luaTargetForUri` has the only two branches this page can need: `procLuaDocs` for a block, ace-linters'
  `$urisToSessionsIds` for a `.lua` tab, then `allAdapters()`.
  **A uri matching nothing open is declined with a notice, never fetched** — the only files this server knows are the
  ones the page has open.
  The `.lua` branch prefers `$messageController.getSessionIdByUri`, which falls back to `convertToUri(uri)`;
  the two sides encode independently (vscode-uri here, Rust `url::Url` there), so a raw string compare would miss any
  path they escape differently.
- The jump SELECTS the target's tab as well as focusing its editor (`revealAdapter` → `tabObjectForAdapter`, text
  viewers matched through their `tabHolder`) — focusing an editor in an unselected tab moves a caret nobody can see.
  That match is guarded on `viewer.tabHolder` being truthy, since `tabHolder === undefined` is true of every CODE tab.
- `luaJumpStack` is what `gotoLastJump` unwinds.
  Entries whose editor has been disposed are skipped, and dropped on the way IN as well: the stack holds strong adapter
  references, so a skipped-but-kept entry pins a destroyed editor, its session and its DOM for the page's life.

**The references prompt** is one row per hit as `<file>:<1-based line>  <source line>`, locations in a side table keyed
by index (`getCompletions` JSON-clones its entries on every keystroke).
Its input is seeded with the identifier asked about (`wordAt`, ace's own word range at the caret), selected by the
shared `[0, Number.MAX_VALUE]`, so it reads as a label and typing replaces it.
The file name stays in the CAPTION here, unlike the rename list: this input is a real filter and `FilteredList` matches
on the caption.

**Rename** asks `textDocument/prepareRename` first, so a caret on a keyword says so instead of opening a prompt that
could only end in "no edits";
its `placeholder` seeds the box.
Under the box is a static list of the occurrences that will be renamed, from ONE `textDocument/references` at
prompt-open — nothing in it depends on what is typed.

Three things that list gets right, all of them ace's prompt being built for pickers rather than free text:

- The location is the row's `meta`, not its caption.
  ace highlights the first `indexOf` of the filter text in the CAPTION, so with the file name in front of the code,
  renaming `expand` in `debug_expand_rrule.sas` highlighted the file name.
- The highlight is pinned by `openListPrompt`'s `highlight` option, the prompt otherwise handing `getPrefix`'s return to
  `popup.setData` as both the filter text and the highlight.
- `staticList` unbinds the navigation keys after the prompt has bound its own, so the selection stays on row 0 and Enter
  means what was typed;
  and every row's `value` is the CURRENT name, so a mouse click — the one path left into a row — is a no-op.

emmylua answers the `changes` form of `WorkspaceEdit`;
`documentChanges` is not handled and says so rather than silently renaming nothing.
**Every target is resolved and checked before a single document is touched** — a half-applied rename leaves code that
doesn't compile — so a file that is not open, or a block edit outside the block's own rows (`blockEditsInside`, both
ends of every edit against `luaRanges()`), refuses the whole operation.
The block guard is belt-and-braces, the blanked document hiding the surrounding SAS, which is why the smoke test
synthesises such an edit to prove it holds.

`flushLspDeltas` drains ace-linters' `$deltaQueue` before asking anything on the `.lua` path (the block path needs
none).
ace-linters batches a session's edits and flushes on its own schedule, so a request sent straight after typing is
answered against stale text — for rename, edits at the wrong columns.
It must special-case an EMPTY but non-null queue, which `$sendDeltaQueue` drops WITHOUT invoking its callback;
awaiting that hangs the command forever.
The non-empty branch is bounded at 5 s for the same class of reason: flushing late is a stale-position risk, never
resolving is a dead editor command.

## The `sas` table

What PROC LUA puts in scope — which a `.lua` script it runs sees exactly as a submit block does — has two halves, only
one of them knowable statically.

**(a) The package API** (`sas.submit`, `sas.open`, the `dsid` methods, the `string`/`table` functions the package adds)
is `src/lua/sas.lua`, an EmmyLua `---@meta` file transcribed from the LDoc comments embedded in
`SASFoundation/9.4/sasexe/sasplua`, the ELF shared library that implements the package and carries its own Lua source as
plaintext.
No client code references it: `src/emmylua-worker.js` fetches it (URL passed in the boot blob as
`self.__ssExtEmmyLuaDefs`) and `didOpen`s it right after forwarding `initialize`, and emmylua indexes every open
document
into one workspace.
`manifest.json` lists `src/lua/*.lua` in `web_accessible_resources` for that fetch.

Its class carries an **index signature** (`---@field [string] fun(...): any`).
Without it emmylua flags every DATA step function as "Undefined field `today`", the file only declaring the package API.

**(b) Every DATA step function** is also callable as `sas.<name>(...)` — thousands, with docs that would go stale — so
these are asked of the SAS server at runtime.
`sasFunctions(prefix)` keeps one scratch SAS document (`file:///ssext/sas-functions.sas`) parked at a data-step
expression (`data _null_;\n x = <prefix>`), `didChange`s the prefix in, and takes the `CompletionItemKind.Function`
entries of one `textDocument/completion`.
~20 ms against the warm worker, so there is no cache;
the server filters by prefix itself and answers nothing under two characters, so there is no "list them all".
That document draws no `publishDiagnostics`, so ace-linters never sees a document it doesn't know.

Those entries are the whole of the `ssextSasFns` completer, which answers only in an `ace/mode/lua` session (or inside a
submit block) and only right after `sas.`.
Docs are `completionItem/resolve`d for the SELECTED row only, from `getDocTooltip`, through `mdToText` — nothing here
bundles a markdown converter.

Two more pieces, each of which cost a visible symptom:

- `sasFnHover(session, pos)` answers hover for `sas.<name>`, wrapped onto the Lua provider and tried BEFORE emmylua's
  own answer, which with the index signature is now always generic.
  It skips the names `sas.lua` declares itself (`sasLuaDeclared()`, one memoized fetch of that file, regexed).
  The two sets overlap (`open`, `close`, `put`, `symget`, `exist`, `sleep`, …) and the package's version is the one in
  scope — `sas.put` PRINTS, while the SAS `PUT()` function formats a value.
  The completer dedupes by caption on the same rule.
- `nudgeSasFnCompletions(editor)` forces ONE fresh gather when a prefix reaches two characters after `sas.`.
  ace gathers once when the popup opens and only re-filters after, so a popup opened at `sas.t` — where the server gave
  us nothing — could never grow the entries that exist at `sas.to`.
  It is deferred by a tick: it runs from the session's `change` event, where the caret has not moved yet, and
  `updateCompletions` re-derives the prefix from the caret.

## `rawChannel(worker)` — the side channels

`ssExt._lspRaw` (SAS) and `ssExt._luaRaw` (Lua): `request`/`notify` onto a server ace-linters already owns, for the
questions it has no API for.

Two rules make sharing one connection safe: the ids are STRINGS (`ssext:<n>`), so they cannot collide with ace-linters'
numeric ones, and the responses are **swallowed**, never forwarded — its connection would otherwise see a reply to a
request it never made.
The swallowing is why the channel owns the worker's `onmessage` shim: that assignment is how vscode-jsonrpc's
`BrowserMessageReader` attaches, so holding the real handler is the only way to decide per message whether it is
forwarded.
Hence also `intercept(fn)` (return `true` to swallow) and `onNotification(method, fn)` (watch without taking it away —
how a `publishDiagnostics` for a PROC LUA document is read while every other one still reaches ace-linters).

`request`'s 5 s timeout is generous on purpose but never approached: these answer in 1–2 ms, the server being in-process
wasm with no network anywhere.

## `src/emmylua-worker.js`

One per page.
Instantiates the wasm and speaks plain LSP JSON-RPC over `postMessage`.

The module has no threads and no stdio, so `tools/emmylua-wasm.patch` gives it a five-call C ABI:
`ela_start`/`alloc`/`push`/`pump`/`take`.
`ela_push` hands the server one message, `ela_pump(steps)` drives its current-thread tokio runtime for a bounded number
of cooperative yields (512 after each incoming message, plus a 64-step `setInterval` heartbeat at 100 ms so the server's
own debounced tasks get polled), `ela_take` pops one outgoing message.

It answers server-to-client requests itself — everything `null` except `workspace/configuration`, which gets `EMMYRC`
for every requested item.
An unanswered one stalls init.

`EMMYRC` is where any `.emmyrc.json` setting goes, there being no such file.
It carries two:

- `runtime.version: "Lua5.2"`.
  The default is 5.4 while PROC LUA is tkLua 5.2, so at the default, 5.3+ syntax the SAS runtime rejects passes
  unremarked and 5.4-only stdlib is offered.
  With it, `7 // 2` reports "integer division is not supported".
- `workspace.workspaceRoots`, which is what makes `require()` resolve to another open `.lua` tab.
  emmylua derives a module name for every file it knows by stripping a root off its path (`add_module_by_path`, in the
  analysis pipeline, so it covers opened documents and not just scanned ones), and with no root nothing is a module.
  The folder can't be known at startup, so `addRoot()` takes it from each `didOpen`'s own URI (skipping the `/ssext/`
  defs) and pushes the accumulated set with `workspace/didChangeConfiguration`.

**`withConfigCapability()` rewrites the forwarded `initialize` to claim `capabilities.workspace.configuration`**, and
without it none of `EMMYRC` is ever applied.
The server reads its configuration only by REQUESTING it (`on_did_change_configuration` throws the notification's own
`settings` away and re-requests), and only when the client declared that capability, which ace-linters never does.

Two repairs of things the client gets wrong:

1. **A `didChange` for a never-opened document is held**, and its text folded into that document's `didOpen` when it
   arrives.
   ace-linters does exactly that when an editor's content lands between `registerEditor` and its connection coming up:
   it flushes the text as a change, then sends a `didOpen` carrying the snapshot it took at registration, which is
   EMPTY — so the server holds an empty file and the tab looks clean until the next edit.
   Folding rather than replaying after the open is deliberate: the held change carries the version the client had at the
   time, and the server ignores a change no newer than the open it just processed.
2. **`diagnosticProvider` is stripped from the initialize result**, so ace-linters never tries to PULL diagnostics.
   emmylua advertises the pull form alongside the push and ace-linters cannot do it: its `doValidation()` is a stub
   returning `[]`, which its `ServiceManager` runs for EVERY open document of the service on every change/open/close,
   posting the empty result as that document's diagnostics — so with several `.lua` tabs open, activity in one wiped the
   others' annotations.
   The capability gates nothing else, so dropping it leaves only the push, which is what already worked.

Its WASI shim is 22 stubs and three real functions (`clock_time_get` — the timers matter, `random_get`, `fd_write` for
the server's stderr log, line-buffered and filtered to WARN/ERROR).
With the Lua stdlib metadata compiled in (`include_dir!`) and the workspace scan patched out, nothing ever touches a
file, which is why a real WASI shim isn't needed;
`fd_prestat_get` returning `EBADF` tells libc's preopen scan there are none.

That "patched out" is load-bearing: on the stock build, setting a workspace root makes the server walk the filesystem,
and against these stubs it either traps (`ENOSYS`) or spins forever (`ENOENT`) inside the synchronous `ela_pump`, which
never returns — a dead worker, not a slow one.

## `tools/emmylua-wasm.patch`

~130 lines, committed, making upstream — which targets an OS process — build for wasm: tokio narrowed to the
wasm-supported features, `mimalloc` and the external-formatter path behind `cfg(not(target_family = "wasm"))`, no
`current_exe()`, a non-blocking `AsyncConnection::recv`, and `crates/emmylua_ls/src/wasm.rs` with the C ABI and a boot
future that answers `initialize` off the channel (the stock path blocks on a stdio read).
Read the patch for the rest;
the analyzer, the handlers and the type checker are untouched.

Two hunks are load-bearing rather than mechanical: `load_workspace_files` returns nothing on wasm and
`register_files_watch` is a no-op there, both so a workspace ROOT can be registered at all (see the dead-worker note
above).
Roots come from `add_main_workspace` independently of the scan, so nothing is lost but the scan.

wasip1 rather than `wasm32-unknown-unknown`: that one additionally needs a forked `emmy_lsp_types`
(`url::Url::from_file_path` is compiled out on it), and a browser fills the same handful of imports either way.
