- [x] ~~browse tabs: behave like windows alt+tab~~ (the list is `__ssf.tabsByAccess()`: most recently selected
      first, never-visited tabs below them in tab-bar order, current tab LAST, so row 0 - the row ace's
      `setData` already leaves selected - is the tab you came from. The sequence numbers are a WeakMap, not a
      field on the tab: SAS Studio JSON-stringifies every tab object into the user's tab preferences on every
      change. They are written by a `StackContainer.prototype._transition` wrap, the same hook the pane-mark
      clearing uses and for the same reason - a `selectChild`/`onTabSelect` wrap misses every tab constructed
      before the patch, which is all the restored ones. Session-only, no persistence.
      The hold behaviour is the HOTKEY path only, since that is the one entry point that has the opening
      KeyboardEvent: `bindKey` now passes it to the action, `noteTabHold` records `{key, mods}` plus whether
      those modifiers were let go BEFORE the prompt was up (the first open of a page loads the ace library
      first, which takes long enough that they usually are - such an open falls back to an ordinary prompt),
      and browse_ss runs two capture-phase window listeners: the hotkey's own key steps the selection with the
      modifiers down, Shift reverses it, a modifier keyup accepts. Wrapping is arithmetic, not `popup.goTo`,
      whose "down" wraps through -1 = no selection. Any character key is a search instead, which retires the
      jump-on-release for good; those characters are inserted by hand and go on being inserted while the
      modifiers are held, since the command line would otherwise be getting Alt+<letter>, which inserts nothing.
      The tabs prompt also stopped restoring its last path - it has no historyKey, and reopening onto the last
      switch's filter text hides the tab you came from. Default hotkey moved to Alt+Q.
      test/units.js covers the ordering, test/smoke.js the whole flow through real key events)
