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
  - [ ] inline editor (kitchen sink's F3) - a separate feature from the diff viewer, and demo-only
        code: ace ships no ext for it, so it would have to be ported
