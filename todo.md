- lua lsp with sas module docs
  - [x] .lua files opened as text: routed through ace-linters, so completion, diagnostics,
        hover, signature help, document highlights, code actions, semantic tokens
  - [x] formatting: Ctrl-Shift-F / command palette (ace-linters' own format() is off by one
        and formats nothing, so the range is built here)
  - [x] ~~sas module docs: meta definitions for the sas.* API, which the server can't know about~~
        (src/lua/sas.lua for the package API, SAS LSP at runtime for the DATA step functions)
  - [x] ~~require() of another open .lua tab~~ (real filePath URIs on the documents +
        workspace roots the worker derives from them; needed two more cfg(wasm) guards in
        tools/emmylua-wasm.patch, since the stock build scans the filesystem for a root)
  - [x] ~~switching an editor's mode from ace's settings pane moves it between the two
        servers~~ (session changeMode -> _syncLspToMode: unregister, re-register with the
        other provider; ace-linters' own changeMode only re-resolves inside its manager)
  - [x] ~~PROC LUA submit;...endsubmit; blocks: completion, diagnostics, hover, semantic
        tokens and signature help~~ (the same worker over a rawChannel side channel, fed the
        sas file with every non-lua line blanked so an LSP position IS an ace position; one
        completer, doHover/provideSignatureHelp wraps on the SAS provider, a setAnnotations
        wrapper so both servers share the gutter, and the tokens decoded and added as the
        same ace text markers ace-linters uses)
  - [x] ~~the lua server was never initialized unless a .lua tab happened to be open~~
        (ace-linters builds its LanguageClient - and sends `initialize` - only when a
        document of that mode is first added, which for a .sas file with a block never
        happens; every side-channel request timed out to null, so NO block feature worked in
        an ordinary .sas file. initLuaService() adds one empty scratch document through
        ace-linters' own init path. The smoke suite had missed it by running its .lua block
        first, which warmed the server up; that block now runs after the PROC LUA one)
  - [x] ~~document highlights inside a block~~ (wrapped on the message controller, not a
        provider method - ace-linters drives these from its own changeSelection timer and
        hands the answer to slp.$applyDocumentHighlight, so ours replaces the SAS request and
        feeds the same callback: its MarkerGroup, its CSS)
  - [x] ~~formatting inside a block~~ (rangeFormatting over the block's rows through _luaRaw;
        the edits are applied last-first, filtered to the block's own rows - a whole-block
        format legitimately ends at (to+1, 0) - and re-indented, since the blanked document
        puts that Lua at the top level and the server returns it flush at column 0.
        The start needs its OWN bound: that (to+1, 0) allowance let a zero-width edit anchored
        on the endsubmit line through, which applies as an insert into SAS code - caught by
        review, demonstrated against the real function, now covered in units.js)
  - code actions inside a block: NOT WANTED (asked for and declined 2026-09-10). The .lua
    path keeps ace-linters' own; a block just doesn't get them.

  - [x] ~~definition / references / rename, for .lua tabs AND blocks~~ (all over _luaRaw and
        all four UIs ours, since ace-linters implements none of them and ace has no
        go-to-definition, references panel or rename widget. Four ace COMMANDS -
        gotoDefinition / findReferences / renameSymbol / gotoLastJump - with NO default keys:
        every candidate is the browser's (F12) or already ace's (F2, Alt-Left) or one of
        ss-fixes' capture-phase Alt+letter globals, and the palette plus a vimrc `<Cmd>`
        mapping reach them anyway)
    - [x] ~~definition: jump plus a jump-back stack~~ (firstLspLocation normalises the three
          shapes the spec allows - emmylua sends a bare Location same-document and an array
          cross-file, both measured)
    - [x] ~~references: one ace/ext/prompt row per hit~~ (targets in a side table keyed by
          index, since getCompletions JSON-clones the entries on every keystroke - the same
          reason the command palette keeps its runners outside. The input is SEEDED with the
          identifier under the caret - ace's own word range, no round trip - and selected, so
          it reads as a label and typing replaces it. The file name stays in the CAPTION here,
          unlike the rename list: this input really is a filter and FilteredList matches on
          the caption, so moving it to meta would take away narrowing the hits by file)
    - [x] ~~rename: prepareRename to validate, then apply the WorkspaceEdit~~ (emmylua
          answers the `changes` form; `documentChanges` is not handled and says so rather
          than silently renaming nothing. Every target is resolved and checked BEFORE any
          document is touched - a half-applied rename leaves code that does not compile)
    - [x] ~~under the rename box, the list of locations that will be renamed~~ (one row per
          occurrence from ONE textDocument/references at prompt-open, STATIC - the rows are
          the source lines as they stand and nothing in them follows the box. The location is
          the row's META, i.e. the right-hand column, which is not cosmetic: ace highlights
          the first indexOf of the filter text in the CAPTION, so with the file name in front
          of the code a rename of `expand` in debug_expand_rrule.sas highlighted the FILE NAME.
          The highlight is pinned to the original name by openListPrompt's `highlight` option
          (the prompt feeds getPrefix's return to popup.setData as its filter text, which is
          both what a picker filters on and what the rows highlight). staticList unbinds the
          arrow keys so the selection cannot leave row 0 and Enter always means what was typed;
          every row's value is the CURRENT name, so the one path left - a click, which ace
          takes outright - is a no-op)
    - [x] ~~cross-file is only ever another OPEN editor~~ (uri -> editor through
          procLuaDocs for a block and ace-linters' own $urisToSessionsIds for a .lua tab,
          then allAdapters(); a uri matching nothing open is declined with a notice. The jump
          SELECTS the target tab too - focusing an editor in an unselected tab moves a caret
          nobody can see)
    - [x] ~~rename in a block is bounded by the block~~ (blockEditsInside checks both ends of
          every edit against luaRanges(); anything outside refuses the whole rename)
    - [x] ~~review follow-ups~~ (three fresh-context reviews, 2026-09-10; three confirmed
      defects fixed - orderedProcLuaEdits letting an edit START on the endsubmit row,
      initLuaService passing `uri` where ace-linters reads `documentUri`/`sessionId`, and the
      false "the SAS server advertises no formatting" claim in a comment AND in AGENTS.md -
      then the rest:)
      - [x] ~~openListPrompt()~~ - the ace/ext/prompt block was three near-verbatim copies
        (command palette, vim mappings, references) and rename would have been the fourth;
        one helper, net negative lines. `entries` is a function of the input so the rename
        preview can rebuild per keystroke, `filter: false` for a free-text input.
      - [x] ~~flushLspDeltas' non-empty branch is now bounded at 5s~~ like every other request
        on these paths; ace-linters registers that callback with no timeout of its own.
      - [x] ~~luaTargetForUri goes through $messageController.getSessionIdByUri~~, which falls
        back to convertToUri(); client and server escape uris independently.
      - [x] ~~reindentEdits no longer swallows a newText:"" deletion~~ (a formatter stripping
        an indent would have de-indented that row); a blank line INSIDE a multi-line
        replacement still gets none.
      - [x] ~~luaJumpStack prunes disposed adapters on push~~, not just on the way back - it
        holds strong references, so a skipped entry pinned a dead editor for the page's life.
      - [x] ~~tabObjectForAdapter guards on viewer.tabHolder~~ - without it an entry with none
        matched EVERY code tab, and the smoke fixtures were walking into exactly that.
      - [x] ~~the four uncovered paths now have checks~~: the gotoLastJump disposed-adapter
        skip, the not-open rename refusal (both documents byte-identical), blockIndent's
        minimum-indent scan (the format fixture is three rows at three indents, so min is
        distinguishable from first and last), and the findDocumentHighlights fall-through on
        a SAS row of a session that has a block.
      - [x] ~~the two vacuous smoke checks~~: gotoLastJump now moves the origin caret away
        first (it was asserting a position nothing had changed), and the block-rename refusal
        is driven through applyRename with a synthesised out-of-block edit rather than
        re-running the units.js predicate.
    - one thing the .lua path needed that the block path did not: ace-linters batches a
      session's edits and flushes them on its own schedule, so a request sent straight after
      typing is answered against stale text - which for rename means edits at the wrong
      columns. flushLspDeltas() drains $deltaQueue first, and has to special-case an EMPTY
      (but non-null) queue: $sendDeltaQueue drops that one without ever calling its callback,
      so awaiting it unguarded hangs the command forever.

- [x] ~~FLAKY TESTS~~ (diagnosed and fixed 2026-09-10; three consecutive clean full runs). Neither
  was a race, and neither was in the code it pointed at:
  - "file diff: the picked file is fetched and shown as the other side": the suspected
    focus/timing race was wrong. The prompt reopens at whatever path it was last left on
    (`lastPaths`), and a typed path OUTSIDE the loaded collection lists a single
    "⬇️ Load content..." row (`uri` = the folder, `meta` ">") - so the first row was the folder
    because the folder had never been loaded, not because the wrong tab was focused. The test
    now accepts that row, which is what a person does: it loads the collection and re-filters on
    the same typed path with the box left alone (`keepPrompt`). Only `keepPrompt` rows are
    accepted - an earlier version keyed on `meta === '>'`, which happily descended into a plain
    directory row and left every later browse check on that folder.
  - "focusSideBarTree reaches the tree from the editor" / "arrow keys then navigate the tree":
    maximized view hides the whole side bar, and it is a SERVER-SIDE user preference - whoever
    last used the app in a browser decided what the run started in. `focusSideBarTree` then
    focused a hidden tree, which is a silent no-op. Fixed on both sides: the action now says
    "Side bar is hidden in maximized view" instead of doing nothing quietly (un-maximizing itself
    would still be a surprising side effect), and the smoke block takes max view off for the
    duration and puts it back.

- allow configuring snippet for all languages, not just sas, using the snippet editor in options page, adding language selection
- SAS log: highlight log line for NOTE, WARNING, ERROR, INFO, DEBUG
- make status bar always show in maximized view, not just when start submit and then hide it when done
- browse tabs: behave like windows alt+tab, sort the tab list by last access on top, current tab at bottom, when first open focus previous tab, pressing the main key (non-modifier key) again while still holding the modifier keys will move the focus forward (to next previous focused tab), releasing all keys to jump to selected tab, pressing any other key start searching, pressing esc to close prompt with no jump