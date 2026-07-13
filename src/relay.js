/**
 * ISOLATED-world content script: MAIN-world code (editor-swap.js,
 * ext-browse_ss.js) can't touch chrome.storage or chrome.action, so it posts
 * via window.postMessage and this relay forwards to the privileged side:
 * - `__ssextAceConfig`: persisted to chrome.storage.local (sw.js's
 *   storage.onChanged then pushes it to every open SASStudio tab).
 * - `__ssextBadge`: sent to sw.js, which sets the per-tab ON/OFF toolbar badge
 *   (content scripts can't call chrome.action themselves).
 * - `__ssextBrowseSet`: browse_ss history/bookmarks persisted to
 *   chrome.storage.local (extension-scoped, survives "clear site data").
 * - `__ssextBrowseGet`: browse_ss reads -> reply posted back as
 *   `__ssextBrowseData` for the MAIN-world cache to populate.
 */
// Only browse_ss's per-host-namespaced keys and the (deliberately global)
// command-palette history may be touched via __ssextBrowseSet/Get - without
// this, MAIN-world code could read/clobber any chrome.storage.local key
// (fixes, hotkeys, snippets, aceConfig).
const isBrowseKey = (k) => k.startsWith("browseSs:") || k === "SsCmdPaletteHistory";

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.__ssextAceConfig !== undefined) {
    chrome.storage.local.set({ aceConfig: event.data.__ssextAceConfig });
  } else if (event.data.__ssextBadge !== undefined) {
    chrome.runtime.sendMessage({ ssextBadge: !!event.data.__ssextBadge });
  } else if (event.data.__ssextBrowseSet) {
    const allowed = Object.fromEntries(
      Object.entries(event.data.__ssextBrowseSet).filter(([k]) => isBrowseKey(k))
    );
    chrome.storage.local.set(allowed);
  } else if (Array.isArray(event.data.__ssextBrowseGet)) {
    const keys = event.data.__ssextBrowseGet.filter(isBrowseKey);
    chrome.storage.local.get(keys).then((obj) => {
      // get() omits keys missing from storage entirely - fill those in with
      // null so every requested key is present in the reply, otherwise the
      // MAIN-world ready() waiter for a never-before-seen key hangs forever.
      const reply = Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
      window.postMessage({ __ssextBrowseData: reply }, "*");
    });
  }
});
