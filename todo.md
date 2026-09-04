- ~~show unsaved changes in gutter or custom scrollbar~~
  → gutter bars per changed/deleted line, diffed against the last saved content
    with ace's own ext/diff line differ (`editor-swap.js`, `_dirtyGutter`)
- ~~browse-ss: configure in option page default action (with Enter key/accept() function) for file types,
  e.g. .log and .lua open as text file, .zip scroll tree to file ; also add hotkeys to download file
  (open with external...)~~
  → options page "File browser config" (`chrome.storage.local.browseFileActions`, extension -> action;
    anything unlisted is revealed in the tree) + two new browse keys: `acceptDownload` (Alt+Enter) and
    `acceptDefault` (Ctrl+Shift+Enter, let SAS Studio decide)
