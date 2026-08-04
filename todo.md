- bug: when enter maximize view, cannot click other tab titles to change focused tab, can still
  change focused tab using ss-ext: next/prev tab commands (and hotkeys)
  - NOT REPRODUCIBLE (2026-08-04), parked. Drove the live instance with playwright, 3 tabs, trusted
    CDP clicks: clicking another tab's title switched focus fine, both after `setMaxView()` and on
    a page that loaded already-maximized (persisted `SWE.maximizedState`). `elementFromPoint` over
    the tab title hits the tab node itself - nothing overlays the tab strip.
