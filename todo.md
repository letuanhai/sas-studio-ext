- ~~completion list item label is cropped even if there is still space left~~
  → `installAutosizeCompletionPopup`: ace never sizes the popup to its content, so the editor's
    completion popup now grows from its widest row (400-800px), capped by the window
- ~~log viewer editor: get full log even when sas studio stop showing log in app~~
  → `openLogInTextTab`/F5 read `editor.logURL` (the whole log) instead of the Log pane, which the
    server stops feeding past a size limit; the pane stays the fallback (append-log mode, failed fetch)

- add features from https://github.com/ajaxorg/ace/tree/master/demo :
  - [x] ~~diff editor (split and inline) of the current file vs its last saved version, and vs
        another file~~
        → `toggleDiffSaved` / `diffAgainstFile` / `toggleDiffMode`: ace's diff views inside the current
          tab (split flexes the pane and puts a read-only editor beside the live one; inline draws the
          other side into it), baseline is the `_savedLines` the unsaved-change gutter already keeps,
          the other file is picked in the browse prompt (`pick_file`) and GET from the workspace
          endpoint. All editor-scoped commands (they need an editor), so they map from a vimrc
          (`nmap ]d <Cmd>gotoNextDiff`): toggleDiffSaved, diffAgainstFile, toggleDiffMode,
          gotoNextDiff/gotoPreviousDiff (Alt+Down/Alt+Up), switchDiffPane, rotateDiffLayout
  - [x] ~~inline editor (kitchen sink's F3) - a separate feature from the diff viewer, and demo-only
        code: ace ships no ext for it, so it would have to be ported~~
        → `toggleInlineEditor` (Alt+Shift+I, editor-scoped like the diff commands, so it maps from a
          vimrc): a second editor in a line widget at the cursor, on a clone of the session (same
          document and undo, own scroll/caret). Resizable, unlike the demo's fixed 10 rows; not F3,
          which is SAS Studio's Run Program

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
  - [ ] a .lua text tab restored at page load now gets the ace overlay from activate(), but
        only once the toggle is switched on - and its module only exists from that point, so
        a require() of it can't resolve before then
  - [ ] require() only finds modules that are OPEN as tabs. The alternative was fetching
        them from the server (GET .../workspace/<path>, an empty body means missing), but
        that blocks while SAS is executing and needs LUAPATH; revisit only if opening the
        module every time proves too annoying
  - [ ] PROC LUA submit;...endsubmit; blocks: completion, diagnostics and hover. Built and
        working once (commit b588131 on lua-lsp: own JSON-RPC client over a second emmylua
        worker, the sas file with non-lua lines blanked, setAnnotations/doHover shared with
        the sas provider), then removed to finish the .lua path and the sas module first
