- ~~show unsaved changes in gutter or custom scrollbar~~
  → gutter bars per changed/deleted line, diffed against the last saved content
    with ace's own ext/diff line differ (`editor-swap.js`, `_dirtyGutter`)
- ~~browse-ss: configure in option page default action (with Enter key/accept() function) for file types,
  e.g. .log and .lua open as text file, .zip scroll tree to file ; also add hotkeys to download file
  (open with external...)~~
  → options page "File browser config" (`chrome.storage.local.browseFileActions`, extension -> action;
    anything unlisted is revealed in the tree) + two new browse keys: `acceptDownload` (Alt+Enter) and
    `acceptDefault` (Ctrl+Shift+Enter, let SAS Studio decide)
- ~~add copy path to context menu library item in libraries tree to copy physical path of the library
  (folder paths for SAS datasets, path string for DBMS,...), note that SAS dataset library can have
  multiple paths~~
  → `librariesContextMenuCopyPath` patch: "Copy Path" in the libraries tree menu, copying every
    `data.concats[].physicalName` (one per line) - the same source the stock Properties dialog reads
