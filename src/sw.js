/**
 * Background service worker.
 *
 * Three independent jobs (the editor toggle / browse / command-palette are all
 * driven from the page now - the popup button for the toggle, in-page ss-fixes
 * hotkeys for browse/palette - so the service worker no longer registers any
 * chrome.commands handler; the only browser command is _execute_action, which
 * Chrome handles itself to open the popup):
 *
 * 1. ss-fixes injection: on every SASStudio page load (tabs.onUpdated), inject
 *    tools-meta.js + ss-fixes.js into the MAIN world and call
 *    window.__ssf.init(settings) with the persisted patch/hotkey settings.
 *    The same handler pre-injects editor-swap.js and seeds
 *    libPath/userSnippets/aceConfig so the global command-palette hotkey works
 *    without a prior toggle.
 *
 * 2. Live snippet apply: when chrome.storage.local's `snippets` changes, push
 *    the new text into every open SASStudio tab via window.__ssExt.applySnippets.
 *
 * 3. Live ace config apply: when chrome.storage.local's `aceConfig` changes
 *    (from the in-page settings panel via relay.js, or from options.html),
 *    push the merged config into every open SASStudio tab via
 *    window.__ssExt.applyAceConfig.
 */

importScripts("defaults.js");

const LIB_PATH = "/lib/ace/src-noconflict";

// In-page editor toggles (command palette etc.) run in the MAIN world and can't
// call chrome.action, so editor-swap.js posts { __ssextBadge } -> relay.js
// -> here to update the per-tab ON/OFF toolbar badge. (The popup sets its own.)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.ssextBadge !== undefined && sender.tab && sender.tab.id !== undefined) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.ssextBadge ? "ON" : "" });
  }
});

// Unset storage -> defaults; a saved value wins even when empty (user cleared).
async function getSnippetsText() {
  const { snippets } = await chrome.storage.local.get("snippets");
  return snippets && typeof snippets.sas === "string" ? snippets.sas : DEFAULT_SAS_SNIPPETS;
}

// Stored value wins per-key over DEFAULT_ACE_CONFIG (shallow merge of the top
// level and of `options`). Shared by the onUpdated seed and the live-apply
// storage listener below.
function mergeAceConfig(stored) {
  stored = stored || {};
  return {
    darkTheme: stored.darkTheme || DEFAULT_ACE_CONFIG.darkTheme,
    lightTheme: stored.lightTheme || DEFAULT_ACE_CONFIG.lightTheme,
    options: Object.assign({}, DEFAULT_ACE_CONFIG.options, stored.options || {}),
    // Unset -> default; a saved value wins even when empty (user cleared it).
    vimrc: typeof stored.vimrc === "string" ? stored.vimrc : DEFAULT_ACE_CONFIG.vimrc,
    lsp: typeof stored.lsp === "boolean" ? stored.lsp : DEFAULT_ACE_CONFIG.lsp,
    lspMaxLines: typeof stored.lspMaxLines === "number" ? stored.lspMaxLines : DEFAULT_ACE_CONFIG.lspMaxLines,
  };
}

async function getAceConfig() {
  const { aceConfig } = await chrome.storage.local.get("aceConfig");
  return mergeAceConfig(aceConfig);
}

// -- ss-fixes injection on every SASStudio page load ---------------------------

const SASSTUDIO_URL_PATTERN = /\/SASStudio\//;

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !SASSTUDIO_URL_PATTERN.test(tab.url)) return;

  try {
    const { fixes, hotkeys } = await chrome.storage.local.get(["fixes", "hotkeys"]);
    const settings = { fixes: fixes || {}, hotkeys: hotkeys || {} };

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/tools-meta.js", "src/ss-fixes.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (s) => window.__ssf.init(s),
      args: [settings],
      world: "MAIN",
    });

    // Pre-inject editor-swap.js (idempotent) with libPath/snippets/aceConfig known,
    // so the global command-palette hotkey (ss-fixes.js's commandPalette action)
    // can call window.__ssExt.commandPalette() with no args and it'll have what
    // it needs to load the Ace lib on demand.
    const libPath = chrome.runtime.getURL(LIB_PATH);
    const snippetsText = await getSnippetsText();
    const aceConfig = await getAceConfig();
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/ace-patches.js", "src/editor-swap.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (path, snippets, config) => {
        // Unconditional: libPath is always this same constant, and userSnippets/
        // aceConfig just mirror current storage - re-setting any of them to the
        // same value on repeat onUpdated firings is harmless (ace/toggle() aren't
        // touched here).
        window.__ssExt.libPath = path;
        window.__ssExt.userSnippets = snippets;
        window.__ssExt.aceConfig = config;
      },
      args: [libPath, snippetsText, aceConfig],
      world: "MAIN",
    });
  } catch (error) {
    console.error("[SS Ext] Error injecting ss-fixes:", error);
  }
});

// -- Live snippet apply on storage change --------------------------------------

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.snippets) {
    const newValue = changes.snippets.newValue;
    const text = newValue && typeof newValue.sas === "string" ? newValue.sas : DEFAULT_SAS_SNIPPETS;

    try {
      const tabs = await chrome.tabs.query({ url: "*://*/SASStudio/*" });
      await Promise.all(
        tabs.map((tab) =>
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: (snippetsText) => {
                window.__ssExt && window.__ssExt.applySnippets && window.__ssExt.applySnippets(snippetsText);
              },
              args: [text],
              world: "MAIN",
            })
            .catch(() => {}), // no-op if editor-swap.js isn't loaded in that tab
        ),
      );
    } catch (error) {
      console.error("[SS Ext] Error live-applying snippets:", error);
    }
  }

  if (changes.aceConfig) {
    const config = mergeAceConfig(changes.aceConfig.newValue);

    try {
      const tabs = await chrome.tabs.query({ url: "*://*/SASStudio/*" });
      await Promise.all(
        tabs.map((tab) =>
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: (cfg) => {
                window.__ssExt && window.__ssExt.applyAceConfig && window.__ssExt.applyAceConfig(cfg);
              },
              args: [config],
              world: "MAIN",
            })
            .catch(() => {}), // no-op if editor-swap.js isn't loaded in that tab
        ),
      );
    } catch (error) {
      console.error("[SS Ext] Error live-applying ace config:", error);
    }
  }
});
