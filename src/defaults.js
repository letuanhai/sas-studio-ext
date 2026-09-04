/**
 * Shared default values for options.js and sw.js.
 *
 * Plain script (no ES modules): loaded via importScripts() in the service worker
 * and via a <script> tag on options.html.
 *
 * DEFAULT_SAS_SNIPPETS is the hand-written custom snippet text that used to live
 * baked into lib/ace/src-noconflict/snippets/sas.js (that file is back to stock
 * ace content now, see DESIGN.md Phase 3 "Snippet un-vendoring"). It's additive
 * over ace's own built-in SAS snippets (parseSnippetFile + register are additive,
 * not a replacement) - native Ace snippet format (`snippet trigger` / tab-indented
 * body), no invented schema.
 */
var DEFAULT_SAS_SNIPPETS = `snippet lua
	proc lua;
	    submit;
	-------- Lua code start --------------*/
	$1
	-------- Lua code end --------------*/
	    endsubmit;
	run;

snippet plog
	putlog \${1:var1}=\${2:var2}=;

snippet cm
	/* $1 */

snippet sqlpass
	proc sql;
		%connect_to_dwh(country=\${1:&country.}, conn_name=dwh);

		create table \${2:tmp_tbl} as
		select * from connection to dwh
		(
	/*-------- Passthrough SQL start --------------*/
		select $4
		from &CONN_WAREHOUSE..$3
	/*-------- Passthrough SQL end --------------*/
		) ;

		disconnect from dwh;
	quit;
`;

/**
 * Dark mode for SAS Studio's OWN interface (the Dojo/dijit app chrome), backed
 * by chrome.storage.local.darkMode and applied as a static stylesheet - see
 * sw.js's syncDarkInjection() and tools/gen-dark-css.js.
 *
 *   "off"    - untouched (the default: this is opt-in, and it leaves an
 *              OS-dark Ace theme alone for anyone who already had one)
 *   "on"     - always dark; also forces Ace onto its dark theme
 *   "system" - dark only when the OS is, via a (prefers-color-scheme: dark)
 *              media attribute on the injected <link>
 */
var DEFAULT_DARK_MODE = "off";

/**
 * What a run is allowed to do to the pane selection (chrome.storage.local's
 * `runFocus`, passed to __ssf.init() by sw.js and read by ss-fixes.js's
 * runFocus patch):
 *
 *   "app"  - SAS Studio's own behavior: the Log pane when the first log line
 *            arrives, then Results / Output data when the run completes
 *   "log"  - the Log pane at run START only; nothing at the end (the default -
 *            seeing the log while it runs is useful, being thrown out of the
 *            code you were reading when it finishes is not)
 *   "none" - never; the updated pane's chip is outlined instead
 *
 * "log" and "none" both outline the chip of any pane they held you back from.
 */
var DEFAULT_RUN_FOCUS = "log";

/**
 * Default Ace editor configuration - the "default for new editors" that the
 * in-page settings panel and options.html both read/write via
 * chrome.storage.local.aceConfig (see editor-swap.js/sw.js/options.js).
 *
 * darkTheme/lightTheme are the deliberate exception: they're only
 * ever set from options.html (the settings panel's single "theme" knob can't
 * express a light/dark pair, so panel changes to "theme" are ignored - see
 * editor-swap.js's panel setOption listener). Everything else in `options` is
 * a generic ace option-name -> value map applied via editor.setOptions(...),
 * additive/overridable by whatever the panel or options page changes.
 */
var DEFAULT_ACE_CONFIG = {
  darkTheme: "ace/theme/gruvbox",
  lightTheme: "ace/theme/chrome",
  options: {
    fontSize: 15,
    keyboardHandler: "ace/keyboard/vim",
    useSoftTabs: true,
    tabSize: 4,
    // Fold widgets on both the opening AND the closing line of a block
    // (ace's default "markbegin" only marks the opening one).
    foldStyle: "markbeginend",
  },
  vimrc: "",
  // SAS language server (completions/hover/diagnostics via ace-linters + a web
  // worker, see editor-swap.js's ensureLsp) - on by default, additive-only: if
  // the server bundle isn't built (./tools/build_lib.sh) or the worker
  // fails, the editor just works as before.
  lsp: true,
  // Skip LSP registration for files longer than this many lines (0 = no limit).
  // Keeps the worker from choking on huge programs; see editor-swap.js's
  // _maybeRegisterLsp.
  lspMaxLines: 1000,
  // Lua language server for PROC LUA submit;...endsubmit; blocks (emmylua
  // compiled to wasm, see editor-swap.js's ensureLuaLsp). Same deal as `lsp`:
  // additive, and a no-op if lib/emmylua-lsp/ hasn't been built. Nothing is
  // fetched until a file with a PROC LUA block asks for a completion.
  luaLsp: true,
};

/**
 * The diff view's own prefs (editor-swap.js's toggleDiffSaved/diffAgainstFile):
 * side-by-side or one editor with the other side drawn into it, and which way
 * round the split is (0-3, rotated a quarter turn at a time by the
 * rotateDiffLayout editor command). Written by those editor commands themselves,
 * never by a settings page - hence a storage key of its own rather than a corner
 * of aceConfig, whose two mergeAceConfig copies whitelist the keys they carry and
 * would drop these on every round trip.
 */
var DEFAULT_DIFF_PREFS = { mode: "split", layout: 0 };

/**
 * What Enter does in the browse prompt (ext-browse_ss.js) for a given file
 * EXTENSION, when it should differ from SAS Studio's own idea of the file type
 * (chrome.storage.local's `browseFileActions`, seeded onto __ssExt by sw.js).
 * Extension (lower case, no dot) -> one of SSF_BROWSE_FILE_ACTIONS' names:
 * "open" (SAS Studio's own handling), "text" (the text viewer), "reveal"
 * (select it in the file tree) or "download".
 *
 * Anything NOT listed is revealed in the tree: SAS Studio's own handling is a
 * download for every type it can't recognise, and no keystroke should do that
 * by accident. So this map is the list of extensions worth OPENING, and it is
 * meant to be edited - these are just the ones the extension itself is about.
 * ("Let SAS Studio decide" / Ctrl+Shift+Enter does it for one file, whatever the map says.)
 *
 * Stored value REPLACES this map rather than merging with it, so an entry can
 * be removed from the options page (same reason `snippets`/`vimrc` work that
 * way).
 */
var DEFAULT_BROWSE_FILE_ACTIONS = {
  sas: "open",
  log: "text",
  lst: "text",
  txt: "text",
  lua: "text",
  sh: "text",
  py: "text",
};
