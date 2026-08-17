/**
 * Popup: editor toggle, native-mouse toggle, and a button that opens the SS-Ext
 * command palette (which now hosts the individual action buttons this popup used
 * to render itself). All configuration lives on the options page.
 */
(function () {
  "use strict";

  const LIB_PATH = "/lib/ace/src-noconflict";

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // Same semantics as sw.js: unset -> defaults, saved value wins even when empty.
  async function getSnippetsText() {
    const { snippets } = await chrome.storage.local.get("snippets");
    return snippets && typeof snippets.sas === "string" ? snippets.sas : window.DEFAULT_SAS_SNIPPETS || "";
  }

  async function injectAndRun(tabId, files, func, args) {
    if (files && files.length) {
      await chrome.scripting.executeScript({ target: { tabId }, files, world: "MAIN" });
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "MAIN" });
    return result;
  }

  function setToggleState(active) {
    const el = document.getElementById("toggle-state");
    el.textContent = active ? "ON" : "OFF";
    el.classList.toggle("on", Boolean(active));
  }

  function setCtxMenuState(nativeOn) {
    const el = document.getElementById("ctxmenu-state");
    el.textContent = nativeOn ? "ON" : "OFF";
    el.classList.toggle("on", Boolean(nativeOn));
  }

  async function handleCtxMenuClick() {
    const tab = await getActiveTab();
    if (!tab || tab.id === undefined) return;
    try {
      const nativeOn = await injectAndRun(
        tab.id,
        ["src/tools-meta.js", "src/ss-fixes.js"],
        () => {
          window.__ssf.run("toggleNativeMouse");
          return Boolean(window.__ssfNativeMouse);
        },
        [],
      );
      setCtxMenuState(nativeOn);
    } catch (e) {
      console.error("[SS Ext] popup context-menu toggle failed:", e);
    }
  }

  async function handleToggleClick() {
    const tab = await getActiveTab();
    if (!tab || tab.id === undefined) return;
    try {
      const libPath = chrome.runtime.getURL(LIB_PATH);
      const snippetsText = await getSnippetsText();
      const result = await injectAndRun(
        tab.id,
        ["src/ace-patches.js", "src/editor-swap.js"],
        (path, snippets) => window.__ssExt.toggle(path, snippets),
        [libPath, snippetsText],
      );
      setToggleState(result && result.active);
      await chrome.action.setBadgeText({ tabId: tab.id, text: result && result.active ? "ON" : "" });
    } catch (e) {
      console.error("[SS Ext] popup toggle failed:", e);
    }
  }

  async function handlePaletteClick() {
    const tab = await getActiveTab();
    if (!tab || tab.id === undefined) return;
    try {
      const libPath = chrome.runtime.getURL(LIB_PATH);
      await injectAndRun(tab.id, ["src/ace-patches.js", "src/editor-swap.js"], (path) => window.__ssExt.commandPalette(path), [libPath]);
      window.close();
    } catch (e) {
      console.error("[SS Ext] popup command palette failed:", e);
    }
  }

  async function loadCookies() {
    const el = document.getElementById("cookies-text");
    try {
      const tab = await getActiveTab();
      if (!tab || !tab.url) return "";
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      const str = cookies
        .filter((c) => c.path === "/SASStudio" && c.httpOnly)
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      el.value = str;
      return str;
    } catch (e) {
      console.error("[SS Ext] popup cookie read failed:", e);
      return "";
    }
  }

  async function handleCopyCookies() {
    const el = document.getElementById("cookies-text");
    const btn = document.getElementById("cookies-copy");
    const str = el.value || (await loadCookies());
    if (!str) return;
    try {
      await navigator.clipboard.writeText(str);
    } catch {
      el.select();
      document.execCommand("copy");
    }
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  }

  // Browse root paths, per SAS Studio host - they name folders on that server, so
  // they can't be one global setting (browse history/bookmarks are host-keyed for
  // the same reason). The popup is inherently scoped to the active tab, which is
  // what makes it the right place for this rather than the options page.
  // Saved on every keystroke: the popup can be dismissed without a blur/change.
  async function initRoots() {
    const row = document.getElementById("roots-row");
    const tab = await getActiveTab();
    let host = "";
    try {
      host = tab && tab.url ? new URL(tab.url).host : "";
    } catch {
      host = "";
    }
    if (!host) {
      row.hidden = true;
      return;
    }
    document.getElementById("roots-host").textContent = host;
    const { browsePaths } = await chrome.storage.local.get("browsePaths");
    const saved = (browsePaths || {})[host] || {};
    ["files", "library"].forEach((kind) => {
      const input = document.getElementById(`root-${kind}`);
      input.value = saved[kind] || "";
      input.addEventListener("input", async () => {
        const { browsePaths } = await chrome.storage.local.get("browsePaths");
        const all = Object.assign({}, browsePaths);
        all[host] = Object.assign({}, all[host], { [kind]: input.value.trim() });
        await chrome.storage.local.set({ browsePaths: all });
      });
    });
  }

  document.getElementById("cookies-copy").addEventListener("click", handleCopyCookies);
  loadCookies();
  initRoots();

  document.getElementById("toggle-btn").addEventListener("click", handleToggleClick);
  document.getElementById("ctxmenu-btn").addEventListener("click", handleCtxMenuClick);
  document.getElementById("palette-btn").addEventListener("click", handlePaletteClick);
  document.getElementById("options-link").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Show the actual toggle state on open (opening the popup grants activeTab).
  (async () => {
    try {
      const tab = await getActiveTab();
      if (!tab || tab.id === undefined) return;
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          ace: Boolean(window.__ssExt && window.__ssExt.active),
          nativeCtxMenu: Boolean(window.__ssfNativeMouse),
        }),
        world: "MAIN",
      });
      setToggleState(result && result.ace);
      setCtxMenuState(result && result.nativeCtxMenu);
    } catch {
      // not a SAS Studio tab / nothing injected yet
      setToggleState(false);
      setCtxMenuState(false);
    }
  })();
})();
