- [x] bug: when 1 file is opened as text using ss-browse Open as text action, open another file with that action will cause the busy dialog to block the app, with error in console as below. using SAS studio native context menu action "View file as text" has no such problem.
Uncaught Error: Tried to register widget with id==editTabContentPane_undefined_texttoolbar but that id is already registered
    at Object.add (registry.js:2:164)
    at Object.create (_WidgetBase.js:2:2440)
    at Object.postscript (_WidgetBase.js:2:1858)
    at Object.advice (dojo.js:2:142292)
    at Object._52d [as postscript] (dojo.js:2:141983)
    at new <anonymous> (dojo.js:2:62995)
    at Object.createFileView (AppDMS.js:2:84730)
    at appDMS.createFileView (editor-swap.js:1036:25)
    at Object.perspectiveFileOpen (AppDMS.js:2:79658)
    at window.appDMS.perspectiveFileOpen (ss-fixes.js:1442:38)

- [x] also add an action to close the busy dialog when sas studio has error and the busy dialog hang the app, basically just `window.dijit.byId("busyDialog").destroyRecursive()` plus any necessary cleanup. restore sas studio to normal working state if possible, otherwise allow the user to use the app (use editor, check opening tabs) but alert that the app should be restarted.
- [x] browse-ss: change the fuzzy search to put exact match on top
- [x] browse-ss: open last navigated path (fallback to default start path) when the popup open. put current tab path (if available) to the default list when the path is empty (above bookmark/history), add the text to denote it is current tab path