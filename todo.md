- ~~completion list item label is cropped even if there is still space left~~
  → `installAutosizeCompletionPopup`: ace never sizes the popup to its content, so the editor's
    completion popup now grows from its widest row (400-800px), capped by the window
- ~~log viewer editor: get full log even when sas studio stop showing log in app~~
  → `openLogInTextTab`/F5 read `editor.logURL` (the whole log) instead of the Log pane, which the
    server stops feeding past a size limit; the pane stays the fallback (append-log mode, failed fetch)
