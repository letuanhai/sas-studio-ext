/**
 * Shared metadata for ss-fixes.js's actions/patches - the popup and options page
 * read this to render buttons/checkboxes/hotkey tables without duplicating labels.
 *
 * Plain script (no ES modules): loaded both as a <script> on extension pages
 * (popup.html/options.html) and injected into the page's MAIN world by sw.js
 * alongside ss-fixes.js, so it has to work in both contexts.
 *
 * Defines a single global: SSF_TOOLS.
 */
(function () {
  "use strict";

  if (window.SSF_TOOLS) return;

  window.SSF_TOOLS = [
    // -- Actions - one-shot commands (popup buttons + optional hotkey) ------------
    {
      name: "reloadCurrentFile",
      kind: "action",
      label: "Reload file",
      title: "Reload currently opened file",
      hotkey: { key: "F5" },
    },
    {
      name: "createNewFile",
      kind: "action",
      label: "New file",
      title: "Create a new SAS program (same as F4 / New > SAS Program)",
      hotkey: { key: "N", altKey: true },
    },
    {
      name: "openUserInputTarget",
      kind: "action",
      label: "Open input path",
      title: `Open the input path, by default it open a file on given the path on the SAS server.
Add a prefix to the path for different option:
- 'tbl:' follow by a table identifier to open a table from library
- 'txt:' to open a file as text
- 'ext:' to download a file to open in external programs
`,
      hotkey: { key: "O", altKey: true },
    },
    {
      name: "saveFileAtPath",
      kind: "action",
      label: "Save file at path",
      title: "Save the current file at the given absolute path, as if using Save As and selecting that path in the destination tree",
      hotkey: { key: "S", altKey: true, shiftKey: true },
    },
    {
      name: "runCurrentProgram",
      kind: "action",
      label: "Run program / selection",
      title: "Submit the current SAS program, or the selected code if there's a selection (like F3)",
      hotkey: null,
    },
    {
      name: "scrollTreeToSelectedNode",
      kind: "action",
      label: "Focus tree on selected node",
      title: "Scroll tree to selected node",
      hotkey: { key: "F6" },
    },
    {
      name: "scrollDestinationTreeToProjectSelectedNode",
      kind: "action",
      label: "Scroll destination tree",
      title: "Focus destination tree on selected node of project tree",
      // Ctrl+Alt+F5 was swallowed by Linux (VT switch); Alt+F6 is safe.
      hotkey: { key: "F6", altKey: true },
    },
    {
      name: "collapseCurrentTree",
      kind: "action",
      label: "Collapse current tree",
      title: "Collapse all",
      hotkey: { key: "F6", ctrlKey: true },
    },
    {
      name: "closeCurrentTab",
      kind: "action",
      label: "Close current tab",
      title: "Close current tab",
      hotkey: { key: "W", altKey: true },
    },
    {
      name: "reopenClosedTab",
      kind: "action",
      label: "Reopen last closed tab",
      title: "Reopen last closed tab from the stack",
      hotkey: { key: "T", altKey: true },
    },
    {
      name: "openLogInNewTab",
      kind: "action",
      label: "Open submission log in new tab",
      title: "Open the log content for current submission in new tab",
      hotkey: { key: "L", altKey: true },
    },
    {
      name: "selectNextTab",
      kind: "action",
      label: "Next tab",
      title: "Select the next tab",
      hotkey: { key: "}", altKey: true, shiftKey: true },
    },
    {
      name: "selectPreviousTab",
      kind: "action",
      label: "Previous tab",
      title: "Select the previous tab",
      hotkey: { key: "{", altKey: true, shiftKey: true },
    },
    {
      name: "copyCurrentTabUri",
      kind: "action",
      label: "Copy current tab URI",
      title: "Copy the path of the item in current tab",
      hotkey: { key: "C", altKey: true },
    },
    {
      name: "resetLayoutCurrentTab",
      kind: "action",
      label: "Reset layout current tab",
      title: "Move all panes within current tab back to the main pane container",
      hotkey: { key: "|", altKey: true, shiftKey: true },
    },
    {
      name: "resetLayoutAllTabs",
      kind: "action",
      label: "Reset layout all tabs",
      title: "Move all panes within all tabs back to the main pane container",
      hotkey: null,
    },
    {
      name: "selectNextPane",
      kind: "action",
      label: "Next pane",
      title: "Select the next pane in current tab",
      hotkey: { key: "]", altKey: true },
    },
    {
      name: "selectPreviousPane",
      kind: "action",
      label: "Previous pane",
      title: "Select the previous pane in current tab",
      hotkey: { key: "[", altKey: true },
    },
    {
      name: "focusCodeEditor",
      kind: "action",
      label: "Focus code editor",
      title: "Focus the code editor of the current tab",
      hotkey: { key: ".", altKey: true },
    },
    {
      name: "commandPalette",
      kind: "action",
      label: "Command palette",
      // event.key for Alt+Shift+P is "P" (uppercase); shiftKey is matched
      // explicitly so this is Alt+Shift+P, distinct from a plain Alt+P.
      title: "Open the SS-Ext command palette",
      hotkey: { key: "P", altKey: true, shiftKey: true },
    },
    {
      name: "browseFiles",
      kind: "action",
      label: "Browse files",
      title: "Browse and open SAS Studio files",
      hotkey: { key: "P", altKey: true },
    },
    {
      name: "browseLibrary",
      kind: "action",
      label: "Browse library",
      title: "Browse SAS Studio library items",
      hotkey: { key: "O", altKey: true },
    },
    {
      name: "browseTabs",
      kind: "action",
      label: "Browse tabs",
      title: "Switch between open SAS Studio tabs",
      hotkey: { key: "T", altKey: true },
    },
    {
      name: "toggleEditor",
      kind: "action",
      label: "Toggle Ace editor",
      title: "Toggle the SAS Studio editor between Ace and the built-in editor",
      hotkey: { key: ".", ctrlKey: true },
    },
    {
      name: "toggleNativeMouse",
      kind: "action",
      label: "Toggle native mouse handling",
      title: "Toggle native browser mouse/gesture handling (drag-select, context menus)",
      hotkey: null, // unbound by default; assignable in the options page
    },

    // -- Patches - passive behavior changes, applied once at init ----------------
    {
      name: "confirmDropFile",
      kind: "patch",
      label: "Confirm on drag-and-drop move",
      title: "Ask for confirmation before moving a file/folder via drag-and-drop",
    },
    {
      name: "noFilterConfirmation",
      kind: "patch",
      label: "No large-table filter confirmation",
      title: "Don't ask for confirmation when filtering large tables",
    },
    {
      name: "middleClickCloseTab",
      kind: "patch",
      label: "Middle-click closes tab",
      title: "Close a tab by middle-clicking it",
    },
    {
      name: "projectsContextMenuCopyUri",
      kind: "patch",
      label: "\"Copy Path\" in project tree context menu",
      title: "Add a Copy Path item to the project tree's right-click menu",
    },
    {
      name: "tabsContextMenuCopyUri",
      kind: "patch",
      label: "\"Copy Path\" in tab context menu",
      title: "Add a Copy Path item to the tab's right-click menu",
    },
    {
      name: "keepAlive",
      kind: "patch",
      label: "Keep session alive",
      title: "Periodically ping the server so the session doesn't time out",
    },
    {
      name: "maximizeEditor",
      kind: "patch",
      label: "Maximize editor cleanup",
      title: "Clean up stray widgets and resize properly when maximizing/restoring the editor view",
    },
    {
      name: "minimizeBusyDialog",
      kind: "patch",
      label: "Auto-minimize run-progress dialog",
      title: "Minimize the run-progress dialog to the bottom-right corner so the app stays usable while a program runs (one foreground run at a time; opening files as text is blocked during a run). Uncheck to leave SAS Studio's dialog untouched.",
    },
    {
      name: "keepFocusAfterSave",
      kind: "patch",
      label: "Keep focus in editor after save",
      title: "After saving a code file, SAS Studio reloads the file tree, which steals focus from the editor. This re-focuses the editor (without moving the cursor) once the tree finishes reloading.",
    },
  ];
})();
