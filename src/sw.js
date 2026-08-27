/**
 * Background service worker.
 *
 * Five independent jobs (the editor toggle / browse / command-palette are all
 * driven from the page now - the popup button for the toggle, in-page ss-fixes
 * hotkeys for browse/palette - so the service worker no longer registers any
 * chrome.commands handler; the only browser command is _execute_action, which
 * Chrome handles itself to open the popup):
 *
 * 1. ss-fixes injection: on every SASStudio page load (tabs.onUpdated), inject
 *    tools-meta.js + ss-fixes.js into the MAIN world and call
 *    window.__ssf.init(settings) with the persisted patch/hotkey settings.
 *    The same handler pre-injects editor-swap.js and seeds
 *    libPath/userSnippets/aceConfig/browsePaths so the global command-palette hotkey works
 *    without a prior toggle.
 *
 * 2. Live snippet apply: when chrome.storage.local's `snippets` changes, push
 *    the new text into every open SASStudio tab via window.__ssExt.applySnippets.
 *
 * 3. Live ace config apply: when chrome.storage.local's `aceConfig` changes
 *    (from the in-page settings panel via relay.js, or from options.html),
 *    push the merged config into every open SASStudio tab via
 *    window.__ssExt.applyAceConfig.
 *
 * 4. Live browse-roots apply: when chrome.storage.local's `browsePaths` changes
 *    (the popup's per-host root paths), assign each open SASStudio tab its own
 *    host's entry on window.__ssExt.browsePaths.
 *
 * 5. Dark mode: register (or unregister) src/dark.css - the static dark theme
 *    for SAS Studio's own UI - as a CSS-only content script, following
 *    chrome.storage.local's `darkMode`.
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

// -- Dark mode for SAS Studio's own UI -----------------------------------------
//
// A static, pre-generated stylesheet (tools/gen-dark-css.js) rather than
// anything that themes at runtime. SAS Studio loads ~95 stylesheets, 77 of them
// via nested @import, so a runtime theming engine has to re-fetch and re-parse
// the lot on every load - losing one sheet to a slow server is what made icon
// buttons come back as bare text labels - and its DOM observer costs ~5x on an
// Ace editor with the SAS LSP attached.
//
// It is attached by src/dark-inject.js as a <link> node rather than registered
// as `css:`, so that it can be taken back out again; see that file. Registering
// the script (rather than injecting per tab) is what gets it in before the
// first paint. "Follow system" prepends dark-media-auto.js, which puts a media
// query on the link - so there is only ever one copy of the stylesheet.
const DARK_SCRIPT_ID = "ssext-dark";
const DARK_CSS_FILE = "src/dark.css";
const DARK_MEDIA = { on: "", system: "(prefers-color-scheme: dark)" };

function darkModeEnabled(mode) {
  return Object.prototype.hasOwnProperty.call(DARK_MEDIA, mode);
}

async function syncDarkInjection(mode) {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DARK_SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DARK_SCRIPT_ID] });
    if (!darkModeEnabled(mode)) return;
    await chrome.scripting.registerContentScripts([
      {
        id: DARK_SCRIPT_ID,
        matches: ["*://*/SASStudio/*"],
        js: mode === "system" ? ["src/dark-media-auto.js", "src/dark-inject.js"] : ["src/dark-inject.js"],
        runAt: "document_start",
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    console.error("[SS Ext] Error registering dark mode injection:", error);
  }
}

// Add/replace/remove the <link> in one already-open tab. Symmetric: because the
// stylesheet is a DOM node we own, every transition applies live, including
// turning dark mode off.
async function applyDarkToTab(tabId, mode) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: (href, media) => {
        const old = document.getElementById("ssext-dark-css");
        if (old) old.remove();
        if (!href) return;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.id = "ssext-dark-css";
        link.href = href;
        if (media) link.media = media;
        document.documentElement.appendChild(link);
      },
      args: [
        darkModeEnabled(mode) ? chrome.runtime.getURL(DARK_CSS_FILE) : "",
        DARK_MEDIA[mode] || "",
      ],
    })
    .catch(() => {}); // tab may not be injectable (still loading, or gone)
}

// Reconcile on every service-worker start: the registration is persisted, but
// this keeps it honest after an update/reinstall that dropped it.
chrome.storage.local
  .get("darkMode")
  .then(({ darkMode }) => syncDarkInjection(darkMode || DEFAULT_DARK_MODE))
  .catch(() => {});

// -- ss-fixes injection on every SASStudio page load ---------------------------

const SASSTUDIO_URL_PATTERN = /\/SASStudio\//;

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !SASSTUDIO_URL_PATTERN.test(tab.url)) return;

  try {
    // keyLayout: the navigator.keyboard.getLayoutMap() result captured by the
    // options page - that API is secure-context only, so the (http) SAS Studio
    // page can't resolve it itself. Absent -> ss-fixes falls back to US layout.
    const { fixes, hotkeys, keyLayout, browsePaths, darkMode } = await chrome.storage.local.get([
      "fixes",
      "hotkeys",
      "keyLayout",
      "browsePaths",
      "darkMode",
    ]);
    const settings = { fixes: fixes || {}, hotkeys: hotkeys || {}, keyLayout: keyLayout || {} };

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/tools-meta.js", "src/ss-fixes.js"],
      world: "MAIN",
    });
    // Pre-inject editor-swap.js (idempotent) with libPath/snippets/aceConfig known,
    // so the global command-palette hotkey (ss-fixes.js's commandPalette action)
    // can call window.__ssExt.commandPalette() with no args and it'll have what
    // it needs to load the Ace lib on demand. Seeded BEFORE __ssf.init() so the
    // aceEditorOnLoad patch has libPath when it fires.
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
      func: (path, snippets, config, paths, dark) => {
        // Unconditional: libPath is always this same constant, and userSnippets/
        // aceConfig just mirror current storage - re-setting any of them to the
        // same value on repeat onUpdated firings is harmless (ace/toggle() aren't
        // touched here).
        window.__ssExt.libPath = path;
        window.__ssExt.userSnippets = snippets;
        window.__ssExt.aceConfig = config;
        // Browse root paths for THIS instance (popup); an empty entry means "use
        // the browser's built-in default" - see ext-browse_ss.js's getStartPath().
        window.__ssExt.browsePaths = paths;
        // Read by prefersDarkTheme(): with dark mode forced on, Ace has to use
        // its dark theme too, whatever the OS says.
        window.__ssExt.darkMode = dark;
      },
      // Root paths name folders on one specific server, so they're stored per
      // host (like the browse history/bookmarks) and only this host's are seeded.
      args: [
        libPath,
        snippetsText,
        aceConfig,
        (browsePaths || {})[new URL(tab.url).host] || {},
        darkMode || DEFAULT_DARK_MODE,
      ],
      world: "MAIN",
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (s) => window.__ssf.init(s),
      args: [settings],
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

  // Dark mode: re-register so the next page load is right, then bring the
  // already-open tabs along. Every transition applies live - on, off, and
  // on<->system - because the stylesheet is a <link> node we own rather than
  // extension-injected CSS, which could never be withdrawn. Ace is re-themed in
  // the same pass so the editor and the app chrome never disagree.
  if (changes.darkMode) {
    const mode = changes.darkMode.newValue || DEFAULT_DARK_MODE;
    await syncDarkInjection(mode);

    try {
      const tabs = await chrome.tabs.query({ url: "*://*/SASStudio/*" });
      await Promise.all(
        tabs.map(async (tab) => {
          await applyDarkToTab(tab.id, mode);
          // applyAceConfig re-runs every editor's applyConfig, which goes
          // through prefersDarkTheme().
          await chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: (dark) => {
                if (!window.__ssExt) return;
                window.__ssExt.darkMode = dark;
                if (window.__ssExt.applyAceConfig && window.__ssExt.aceConfig) {
                  window.__ssExt.applyAceConfig(window.__ssExt.aceConfig);
                }
              },
              args: [mode],
              world: "MAIN",
            })
            .catch(() => {}); // no-op if editor-swap.js isn't loaded in that tab
        }),
      );
    } catch (error) {
      console.error("[SS Ext] Error live-applying dark mode:", error);
    }
  }

  // Browse roots (popup): plain assignment is enough - ext-browse_ss.js reads
  // __ssExt.browsePaths when a prompt opens, so the next Alt+P uses the new root
  // without a page reload. Each tab gets only its own host's entry.
  if (changes.browsePaths) {
    const byHost = changes.browsePaths.newValue || {};

    try {
      const tabs = await chrome.tabs.query({ url: "*://*/SASStudio/*" });
      await Promise.all(
        tabs.map((tab) =>
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: (paths) => {
                if (window.__ssExt) window.__ssExt.browsePaths = paths;
              },
              args: [byHost[new URL(tab.url).host] || {}],
              world: "MAIN",
            })
            .catch(() => {}), // no-op if editor-swap.js isn't loaded in that tab
        ),
      );
    } catch (error) {
      console.error("[SS Ext] Error live-applying browse roots:", error);
    }
  }
});
