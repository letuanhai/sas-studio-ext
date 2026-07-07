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
  lightTheme: "ace/theme/iplastic",
  options: {
    fontSize: 15,
    keyboardHandler: "ace/keyboard/vim",
    useSoftTabs: true,
    tabSize: 4,
  },
  vimrc: "",
  // SAS language server (completions/hover/diagnostics via ace-linters + a web
  // worker, see editor-swap.js's ensureLsp) - on by default, additive-only: if
  // the server bundle isn't built (./build_lib.sh) or the worker
  // fails, the editor just works as before.
  lsp: true,
  // Skip LSP registration for files longer than this many lines (0 = no limit).
  // Keeps the worker from choking on huge programs; see editor-swap.js's
  // _maybeRegisterLsp.
  lspMaxLines: 500,
};
