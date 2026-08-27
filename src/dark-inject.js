/**
 * Attaches the dark stylesheet as a real <link> node in the page.
 *
 * Registered (with sw.js's chrome.scripting.registerContentScripts) only when
 * dark mode is on, at document_start, so this runs before the page renders.
 *
 * Why a <link> we create instead of just registering `css: ["src/dark.css"]`,
 * which is the obvious thing: CSS injected by the extension goes into a
 * separate injection origin that the page can't see. It isn't in
 * document.styleSheets, and chrome.scripting.removeCSS only knows about sheets
 * added with insertCSS - so once it was in, nothing could take it out, and
 * turning dark mode off needed a page reload. A <link> element is an ordinary
 * DOM node we own, so sw.js can drop it from an open tab at any time. (This is
 * exactly how Dark Reader itself toggles live: it appends its own
 * <style class="darkreader"> nodes and removes them again.)
 *
 * Appended to documentElement rather than head because at document_start <head>
 * may not exist yet. A stylesheet in the document blocks rendering until it
 * loads, and this one is a local extension resource, so the first paint already
 * has it - measured, see the dark-mode section of test/smoke.js.
 *
 * __ssextDarkMedia is set by src/dark-media-auto.js, which sw.js registers
 * ahead of this file for "follow system" mode - content scripts in one
 * registration share an isolated world and run in order. That media attribute
 * is the whole of "follow system", which is why there's no second copy of the
 * stylesheet for it.
 */
(() => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.id = "ssext-dark-css";
  link.href = chrome.runtime.getURL("src/dark.css");
  if (typeof __ssextDarkMedia === "string") link.media = __ssextDarkMedia;
  document.documentElement.appendChild(link);
})();
