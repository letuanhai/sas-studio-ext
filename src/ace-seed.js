// Applies the ace-patches on an extension page (options.html), loaded between
// ext-modelist.js and ext-settings_menu.js so the SAS modelist entry exists
// before ext-settings_menu's bundled ace/ext/options snapshots modelist.modes
// into the settings-menu Mode dropdown. A separate file because the extension
// CSP (script-src 'self') forbids the inline <script> this would otherwise be.
window.__ssExtApplyAcePatches && window.__ssExtApplyAcePatches(window.__ssAce);
