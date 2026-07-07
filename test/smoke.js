/**
 * End-to-end smoke test: loads the unpacked extension in Chromium against a live
 * SAS Studio instance and exercises the page-side features.
 *
 * Run:  node test/smoke.js
 * Env:  SS_URL      SAS Studio URL      (default http://192.168.1.72/SASStudio/38/)
 *       CHROME_BIN  Chromium executable (default: playwright's bundled chromium)
 * Needs the `playwright` module resolvable (npx playwright / NODE_PATH / local install)
 * and at least one closable FILE tab open in the SAS Studio session.
 *
 * If `playwright` isn't installed and `npx playwright ...` can't reach the network
 * either, check under `~/.npm/_npx/` (one subdir per past npx invocation) for a
 * `node_modules/playwright` left by a previous run and point NODE_PATH at that
 * node_modules dir. Then set CHROME_BIN to a matching Chromium build found under
 * `~/.cache/ms-playwright/` (look for a `chromium-<build>/chrome-linux64/chrome`)
 * (playwright's own launcher hardcodes a build number - a version mismatch between
 * the npx-cached `playwright` and whatever's in that cache dir makes the default
 * `chromium.launch()`/`executablePath()` point at a build that isn't actually there).
 * Don't use a real Chrome (e.g. `google-chrome-stable`) as CHROME_BIN: unlike
 * playwright's bundled Chromium, it silently fails to load `--load-extension` in
 * headless mode (chrome://extensions comes up empty, no error) even with
 * `--disable-extensions-except` and `ignoreDefaultArgs: ["--disable-extensions"]`.
 *
 * Also needs `lib/ace/src-noconflict/ace.js` and `lib/ace-linters/*.js` present
 * (the fast, network-only part of `./build_lib.sh` - its `npm pack` calls for
 * ace-builds/ace-linters) or the Ace-activation tests fail on a 404. The slow
 * `lib/sas-lsp` clone+webpack build is only needed for the LSP-specific checks;
 * everything else degrades gracefully (one console warning) without it.
 *
 * Middle-clicks are sent as raw CDP input (trusted, full event pipeline) - this is
 * what caught the dojo/touch.js dojoClick suppression bug that synthetic
 * dispatchEvent-based tests can't see.
 */
const { chromium } = require("playwright");

const EXT = require("path").resolve(__dirname, "..");
const URL = process.env.SS_URL || "http://192.168.1.72/SASStudio/38/";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[SS Ext]") && m.type() === "error") console.log("PAGE ERROR:", t);
  });
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector(".dijitTreeNode", { timeout: 45000 });
  await page.waitForTimeout(3000);

  // Dismiss the autosave-recovery dialog if present ("The autosave file ... is
  // newer ..."). Smoke runs themselves cause it: they type into the code editor
  // and then kill the browser without saving, so the next session starts with
  // this modal up, which blocks the tab hit-test and eats Esc. Answer "No"
  // (keep the server copy - the edits were test noise).
  const dismissed = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll(".dijitDialog")].find(
      (d) => d.offsetParent !== null && /autosave/i.test(d.textContent),
    );
    if (!dlg) return false;
    const no = [...dlg.querySelectorAll("span,button")].find((b) => b.textContent.trim() === "No");
    if (no) no.click();
    return !!no;
  });
  if (dismissed) {
    console.log("note: dismissed autosave-recovery dialog left by a previous run");
    await page.waitForTimeout(1000);
  }

  // -- injection + init ---------------------------------------------------------
  const state = await page.evaluate(() => ({
    initialized: !!(window.__ssf && window.__ssf._initialized),
    toolsMeta: Array.isArray(window.SSF_TOOLS),
    closedTabsTracking: Array.isArray(window.__ssfClosedTabs),
    closeTabWrapped: !!window.appDMS.tabs._closeTabOrig,
    tabCount: window.appDMS.tabs.getAllTabObjects().length,
  }));
  check("ss-fixes injected and initialized", state.initialized && state.toolsMeta, state);
  check("reopenClosedTab tracking installed", state.closedTabsTracking && state.closeTabWrapped, state);
  if (state.tabCount < 1) {
    check("at least one tab open in session (needed for middle-click test)", false, state);
  } else {
    // -- middle-click close (raw CDP input) --------------------------------------
    // Pick a tab whose button is actually hittable at its center - depending on
    // session layout, some tab buttons are overlaid (elementFromPoint lands
    // elsewhere) and a trusted click can never reach them.
    const pt = await page.evaluate(() => {
      for (const t of window.appDMS.tabs.getAllTabObjects()) {
        const node = (t.tab ?? t).controlButton && (t.tab ?? t).controlButton.domNode;
        if (!node) continue;
        const r = node.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && node.contains(hit)) return { x, y, name: t.name || t.title };
      }
      return null;
    });
    if (!pt) {
      check("found a hittable tab button (needed for middle-click test)", false, {});
    } else {
      const cdp = await ctx.newCDPSession(page);
      const base = { x: pt.x, y: pt.y, button: "middle", buttons: 4, clickCount: 1 };
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      await page.waitForTimeout(1500);

      const afterClose = await page.evaluate(() => ({
        count: window.appDMS.tabs.getAllTabObjects().length,
        stack: window.__ssfClosedTabs.map((c) => c.name),
      }));
      const closed = afterClose.count === state.tabCount - 1 && afterClose.stack.includes(pt.name);
      check("middle-click closes tab", afterClose.count === state.tabCount - 1, afterClose);
      check("closed tab tracked for reopen", afterClose.stack.includes(pt.name), afterClose);

      // -- reopen (only meaningful if the close above actually happened) -----------
      if (closed) {
        await page.evaluate(() => window.__ssf.run("reopenClosedTab"));
        await page.waitForTimeout(2500);
        const afterReopen = await page.evaluate(() => window.appDMS.tabs.getAllTabObjects().length);
        check("reopenClosedTab restores tab", afterReopen === state.tabCount, { afterReopen });
      } else {
        check("reopenClosedTab restores tab (skipped: close failed)", false, afterClose);
      }
    }
  }

  // -- native mouse handling toggle (live) ----------------------------------------
  const nativeMode = await page.evaluate(() => {
    window.__ssf.run("toggleNativeMouse");
    // with the blocker ON, a mousedown dispatched at a tree label must never
    // reach a document-level listener (all page handlers are starved)
    let reachedDoc = false;
    const docProbe = () => (reachedDoc = true);
    document.addEventListener("mousedown", docProbe, true);
    const label = document.querySelector(".dijitTreeLabel");
    label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.removeEventListener("mousedown", docProbe, true);
    const on = {
      state: Boolean(window.__ssfNativeMouse),
      css: !!document.getElementById("ssf-native-mode-css"),
      selectable: getComputedStyle(label).userSelect === "text",
      gestureBlocked: !reachedDoc,
    };
    window.__ssf.run("toggleNativeMouse");
    label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const off = {
      state: !window.__ssfNativeMouse,
      css: !document.getElementById("ssf-native-mode-css"),
    };
    return { on, off };
  });
  check(
    "native mouse mode blocks page gesture handlers and enables selection css",
    Object.values(nativeMode.on).every(Boolean) && Object.values(nativeMode.off).every(Boolean),
    nativeMode,
  );

  // -- Ace activation + read-only text viewer -------------------------------------
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = sw.url().split("/")[2]; // chrome-extension://<id>/sw.js
  const libPath = `chrome-extension://${extId}/lib/ace/src-noconflict`;

  await page.addScriptTag({ path: require("path").join(EXT, "src", "editor-swap.js") });
  const activated = await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  check("Ace editor replacement activates", activated && activated.active === true, activated);

  // -- SAS language server (LSP) ---------------------------------------------------
  // Activation above already swapped any open SAS tabs to Ace (ace/mode/sas
  // triggers ensureLsp() from the adapter constructor) - poll for the worker/
  // provider to come up rather than assume a fixed delay.
  const lspState = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      if (window.__ssExt._lspProvider && window.__ssExt._lspReady) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      hasProvider: !!window.__ssExt._lspProvider,
      ready: window.__ssExt._lspReady === true,
      failed: !!window.__ssExt._lspFailed,
    };
  });
  check(
    "LSP provider comes up and reports ready within 20s",
    lspState.hasProvider && lspState.ready,
    lspState,
  );

  // -- LSP line limit (aceConfig.lspMaxLines) --------------------------------------
  // With the limit set below the content's line count, a fresh SAS adapter must
  // not register with the LSP provider; with the limit disabled (0), it must.
  const lspMaxLinesState = await page.evaluate(async () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `/* line ${i} */`).join("\n");

    window.__ssExt.aceConfig = { lsp: true, lspMaxLines: 1 };
    const divOver = document.createElement("div");
    divOver.id = "ssext_smoke_lsp_over";
    document.body.appendChild(divOver);
    const overAdapter = new window.__ssExt.AceEditorAdapter(divOver.id, manyLines, "sas");
    // Eligibility is checked synchronously before ensureLsp() is even called,
    // so no polling needed here - it never starts registering.
    const overRegistered = overAdapter._lspRegistered;
    overAdapter.dispose();
    divOver.remove();

    window.__ssExt.aceConfig = { lsp: true, lspMaxLines: 0 };
    const divUnlimited = document.createElement("div");
    divUnlimited.id = "ssext_smoke_lsp_unlimited";
    document.body.appendChild(divUnlimited);
    const unlimitedAdapter = new window.__ssExt.AceEditorAdapter(divUnlimited.id, manyLines, "sas");
    let unlimitedRegistered = false;
    for (let i = 0; i < 40; i++) {
      if (unlimitedAdapter._lspRegistered) {
        unlimitedRegistered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    unlimitedAdapter.dispose();
    divUnlimited.remove();

    return { overRegistered, unlimitedRegistered };
  });
  check(
    "lspMaxLines below the file's line count skips LSP registration",
    lspMaxLinesState.overRegistered === false,
    lspMaxLinesState,
  );
  check(
    lspState.hasProvider
      ? "lspMaxLines: 0 (no limit) still registers LSP"
      : "lspMaxLines: 0 (no limit) still registers LSP (skipped: no LSP provider, see above)",
    !lspState.hasProvider || lspMaxLinesState.unlimitedRegistered === true,
    lspMaxLinesState,
  );

  // Pick a real, non-empty file that isn't already open as a tab - opening an
  // already-open uri just re-focuses that tab instead of creating a viewer.
  // Enumerate the workspace root folder (entries with a `size` are files).
  const beforeOpen = await page.evaluate(async () => {
    const a = window.appDMS;
    const openUris = new Set(a.tabs.getAllTabObjects().map((t) => t.uri));
    const root = "/folders/myfolders";
    const url = a.baseURL + "/sasexec/sessions/" + a.sessionId + "/workspace/" + encodeValue(root) + "?includeChildren=true";
    const children = await new Promise((res) => {
      dojo.xhrGet({
        url,
        handleAs: "json",
        preventCache: true,
        load: (d) => res((d && d[0] && d[0].children) || []),
        error: () => res([]),
      });
    });
    const f = children.find(
      (c) => c.size && Number(c.size) > 0 && !openUris.has(`${root}/${c.name}`),
    );
    return f ? { uri: `${root}/${f.name}`, name: f.name } : null;
  });
  if (!beforeOpen) {
    check("found a non-open file to open as text (needed for text-viewer test)", false, beforeOpen);
  } else {
    await page.evaluate(
      (f) =>
        window.appDMS.handleWebOneEvent("FileOpenWithTextViewer", {
          uri: f.uri,
          name: f.name,
          type: "FILE",
          fileType: "TXT",
          // same normalization AppDMS does; without it the viewer toolbar gets a
          // "..._undefined_texttoolbar" id that collides with any other id-less viewer
          id: f.uri.replaceAll("/", "~ps~"),
        }),
      beforeOpen,
    );
    await page.waitForTimeout(3000);

    const viewer = await page.evaluate(async () => {
      const tabs = window.appDMS.tabs.getAllTabObjects();
      const newest = tabs[tabs.length - 1];
      const tabHolder = newest && newest.tab && newest.tab.tabHolder;
      const entry = window.__ssExt._textViewers.find((e) => e.tabHolder === tabHolder);
      if (!entry) return { found: false, tabCount: tabs.length };

      const divId = `ssf_textviewer_${entry.pane.id}`;
      const hasDiv = !!document.getElementById(divId);

      // Regression guard for the empty-editor bug: the load xhr should already
      // have mirrored real file content into Ace by now.
      const loadedContentLength = entry.adapter.getText().length;

      // Regression guard for the forever-spinner bug: AppDMS navigates to the
      // textarea POSITIONALLY (pane.getChildren()[1].getChildren()[0].value) -
      // that must be a live widget with a readable .value, not a destroyed one.
      let positionalGuardOk = false;
      let positionalGuardValue = null;
      try {
        const node = entry.pane.getChildren()[0];
        positionalGuardValue = node.value;
        positionalGuardOk = typeof positionalGuardValue === "string";
      } catch (e) {
        positionalGuardOk = false;
      }

      // The real widget (not a shim) must still be in tabHolder.simpleTextArea,
      // and pushing a value through it must mirror into Ace.
      const isRealWidget = !!(tabHolder.simpleTextArea && tabHolder.simpleTextArea.declaredClass);
      tabHolder.simpleTextArea.set("value", "SMOKE");
      const mirrorRoundtrip = entry.adapter.getText() === "SMOKE";
      // Server/refresh writes must NOT mark the viewer dirty.
      const cleanAfterServerWrite = entry.dirty === false;
      // Always editable now (no Edit button).
      const editableByDefault = entry.adapter.readOnly() === false;
      const noEditButton = !entry.buttons.edit;

      const saveBtn = entry.buttons.save;
      const saveDisabledInitially = !!(saveBtn && saveBtn.get("disabled"));

      // Trigger a real edit (setText() doesn't reliably fire textChanged) and
      // check dirty tracking, Save enabling, and the tab "*" marker - do NOT
      // click Save, so the real file on the server is never touched.
      entry.adapter.aceEditor.insert("x");
      await new Promise((r) => setTimeout(r, 100));
      const dirtyAfterEdit = entry.dirty === true;
      const saveEnabledAfterEdit = !!(saveBtn && !saveBtn.get("disabled"));
      const tabLabel = newest.tab.controlButton && newest.tab.controlButton.containerNode.textContent;
      const tabMarkedDirty = typeof tabLabel === "string" && tabLabel.indexOf("*") === 0;

      // Ctrl+S command is registered on the adapter.
      const hasSaveCommand = !!entry.adapter.aceEditor.commands.commands.ssfSaveTextViewer;

      return {
        found: true,
        hasDiv,
        loadedContentLength,
        positionalGuardOk,
        isRealWidget,
        mirrorRoundtrip,
        cleanAfterServerWrite,
        editableByDefault,
        noEditButton,
        saveDisabledInitially,
        dirtyAfterEdit,
        saveEnabledAfterEdit,
        tabMarkedDirty,
        hasSaveCommand,
        newTabId: newest.tab.id,
      };
    });

    // vim :w/:q/:wq/:x install is async (config.loadModule); poll for the module
    // to load and our install flag to flip, without re-registering (that would
    // clobber the real handlers).
    const exOk = await page.evaluate(async () => {
      for (let i = 0; i < 30; i++) {
        const mod = window.__ssExt.newLib.ace.require("ace/keyboard/vim");
        if (mod && mod.Vim && typeof mod.Vim.defineEx === "function" && window.__ssExt._vimExInstalled) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });

    check("text viewer converted to Ace (registry entry found)", viewer.found, viewer);
    if (viewer.found) {
      check("ace container div present in DOM", viewer.hasDiv, viewer);
      check("text content actually loaded into Ace (non-empty)", viewer.loadedContentLength > 0, viewer);
      check(
        "positional refresh guard (pane.getChildren()[1].getChildren()[0].value) is safe",
        viewer.positionalGuardOk,
        viewer,
      );
      check("tabHolder.simpleTextArea is the real dijit widget, not a shim", viewer.isRealWidget, viewer);
      check("simpleTextArea value writes mirror into the adapter", viewer.mirrorRoundtrip, viewer);
      check("server/refresh writes do not mark dirty", viewer.cleanAfterServerWrite, viewer);
      check("text viewer is editable by default (no Edit button)", viewer.editableByDefault && viewer.noEditButton, viewer);
      check("save button starts disabled", viewer.saveDisabledInitially, viewer);
      check("editing marks the entry dirty", viewer.dirtyAfterEdit, viewer);
      check("save button enables after a real edit", viewer.saveEnabledAfterEdit, viewer);
      check("tab title shows dirty marker after edit", viewer.tabMarkedDirty, viewer);
      check("Ctrl/Cmd+S save command registered on adapter", viewer.hasSaveCommand, viewer);
      check("vim :w/:q/:wq/:x ex-commands registered", exOk, { exOk });

      // focus-code-editor + reload-file actions on the focused text-viewer tab.
      const focusResult = await page.evaluate(async () => {
        const tabs = window.appDMS.tabs.getAllTabObjects();
        const newest = tabs[tabs.length - 1];
        window.appDMS.tabs.selectTab(newest);
        const entry = window.__ssExt._textViewers.find((e) => e.tabHolder === newest.tab.tabHolder);
        window.__ssf.run("focusCodeEditor");
        await new Promise((r) => setTimeout(r, 200));
        return { focused: entry.adapter.aceEditor.isFocused(), dirtyBeforeReload: entry.dirty };
      });
      check("focus-code-editor focuses the text viewer's Ace adapter", focusResult.focused, focusResult);

      // Reload (same path as the Refresh button) must clear the dirty state.
      await page.evaluate(() => window.__ssf.run("reloadCurrentFile"));
      await page.waitForTimeout(3500);
      const afterReload = await page.evaluate(() => {
        const tabs = window.appDMS.tabs.getAllTabObjects();
        const newest = tabs[tabs.length - 1];
        const entry = window.__ssExt._textViewers.find((e) => e.tabHolder === newest.tab.tabHolder);
        if (!entry) return { gone: true };
        const label = newest.tab.controlButton && newest.tab.controlButton.containerNode.textContent;
        return {
          dirty: entry.dirty,
          saveDisabled: !!(entry.buttons.save && entry.buttons.save.get("disabled")),
          markerCleared: !(typeof label === "string" && label.indexOf("*") === 0),
        };
      });
      check(
        "reload clears text viewer dirty marker and disables save",
        !afterReload.dirty && afterReload.saveDisabled && afterReload.markerCleared,
        afterReload,
      );

      // Dirty text viewer closed via the tab's own "x" (tab.onClose, what
      // _onTabClose gates - not the programmatic tabs.closeTab used below) must
      // prompt with the stock save/don't-save/cancel dialog, same as a real
      // code editor tab.
      await page.evaluate((tabId) => {
        const entry = window.__ssExt._textViewers.find(
          (e) => e.tabHolder === dijit.byId(tabId).tabHolder,
        );
        entry.adapter.aceEditor.insert("y");
      }, viewer.newTabId);
      await page.waitForTimeout(200);
      const closeConfirm = await page.evaluate((tabId) => {
        const tabObj = window.appDMS.tabs.getAllTabObjects().find((t) => t.tab.id === tabId);
        tabObj.tab.onClose();
        const dialog = Object.values(dijit.registry._hash || {}).find(
          (w) => w.id && w.id.indexOf("tabsFileCloseConfirmation_") === 0,
        );
        return { dialogShown: !!dialog, stillOpen: !!dijit.byId(tabId), dialogId: dialog && dialog.id };
      }, viewer.newTabId);
      check("dirty text viewer close prompts confirmation dialog", closeConfirm.dialogShown, closeConfirm);
      check("tab stays open until the dialog is answered", closeConfirm.stillOpen, closeConfirm);
      if (closeConfirm.dialogShown) {
        await page.evaluate((dialogId) => {
          dijit.byId(dialogId + "_dontSaveBtn").onClick();
        }, closeConfirm.dialogId);
        await page.waitForTimeout(500);
      }
      const afterConfirmClose = await page.evaluate((tabId) => !dijit.byId(tabId), viewer.newTabId);
      check("Don't Save closes the tab", afterConfirmClose, { afterConfirmClose });

      const afterClose = await page.evaluate(() => window.__ssExt._textViewers.length);
      check("registry entry cleaned up on tab close", afterClose === 0, { afterClose });
    }
  }

  // -- Command palette -------------------------------------------------------------
  // Nothing focused: only SS-Ext entries should show up.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.evaluate((lp) => {
    window.__ssExt.commandPalette(lp);
  }, libPath);
  await page.waitForTimeout(500);
  const paletteNoFocusState = await page.evaluate(() => {
    const overlay = document.querySelector(".ace_prompt_container");
    const list = window.__ssCmdPalette_lastList || [];
    return {
      overlayPresent: !!overlay,
      hasSsExtEntry: list.some((c) => c.value.startsWith("SS-Ext: ")),
      hasBareAceCommand: list.some((c) => !c.value.startsWith("SS-Ext: ")),
      hasBrowseEntries: ["SS-Ext: Browse files", "SS-Ext: Browse library", "SS-Ext: Browse tabs"].every((v) =>
        list.some((c) => c.value === v),
      ),
      count: list.length,
    };
  });
  check("command palette (no focus) shows overlay", paletteNoFocusState.overlayPresent, paletteNoFocusState);
  check("command palette (no focus) lists SS-Ext entries", paletteNoFocusState.hasSsExtEntry, paletteNoFocusState);
  check("command palette (no focus) has no editor commands", !paletteNoFocusState.hasBareAceCommand, paletteNoFocusState);
  check("command palette lists SS-Ext browse entries", paletteNoFocusState.hasBrowseEntries, paletteNoFocusState);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);
  const paletteClosedAfterEsc = await page.evaluate(() => !document.querySelector(".ace_prompt_container"));
  check("command palette closes on Esc", paletteClosedAfterEsc, { paletteClosedAfterEsc });

  // browseFiles action opens the browse_ss prompt (its own container).
  await page.evaluate(() => window.__ssf.run("browseFiles"));
  await page.waitForTimeout(600);
  const browseOpened = await page.evaluate(() => !!document.querySelector(".ace_browse_ss_container"));
  check("browseFiles action opens the file browser prompt", browseOpened, { browseOpened });
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);

  // With a code editor (an Ace instance) focused: editor commands should also
  // show up. Reuses any currently-open code tab rather than the (now-closed)
  // text viewer from the block above.
  const focusedForPalette = await page.evaluate(async () => {
    const tabObj = window.appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor);
    if (!tabObj) return false;
    window.appDMS.tabs.selectTab(tabObj);
    tabObj.editor.editor.aceEditor.focus();
    await new Promise((r) => setTimeout(r, 100));
    return tabObj.editor.editor.aceEditor.isFocused();
  });
  if (!focusedForPalette) {
    check("command palette (editor focused) test setup - a code editor is focused (skipped: no code tab open)", false, {
      focusedForPalette,
    });
  } else {
    await page.evaluate((lp) => {
      window.__ssExt.commandPalette(lp);
    }, libPath);
    await page.waitForTimeout(500);
    const paletteWithFocusState = await page.evaluate((baselineCount) => {
      const overlay = document.querySelector(".ace_prompt_container");
      const list = window.__ssCmdPalette_lastList || [];
      return {
        overlayPresent: !!overlay,
        count: list.length,
        moreThanBaseline: list.length > baselineCount,
        // entries display description text now, not command ids
        hasKnownAceCommand: list.some((c) => c.command === "find" || c.command === "gotoline"),
        displaysDescriptionText: list.some((c) => c.command === "find" && c.value !== "find"),
        hasNoCustomPrefsEntry: !list.some((c) => c.value === "SS-Ext: Editor preferences"),
        // browseSs* editor commands are excluded (browsing is listed globally as SS-Ext entries)
        hasNoEditorBrowseCmds: !list.some((c) =>
          ["browseSsFiles", "browseSsLibrary", "browseSsTabs"].includes(c.command),
        ),
      };
    }, paletteNoFocusState.count);
    check("command palette (editor focused) shows overlay", paletteWithFocusState.overlayPresent, paletteWithFocusState);
    check(
      "command palette (editor focused) includes editor commands with description text",
      paletteWithFocusState.moreThanBaseline &&
        paletteWithFocusState.hasKnownAceCommand &&
        paletteWithFocusState.displaysDescriptionText,
      paletteWithFocusState,
    );
    check(
      "command palette has no custom 'SS-Ext: Editor preferences' entry (removed)",
      paletteWithFocusState.hasNoCustomPrefsEntry,
      paletteWithFocusState,
    );
    check(
      "command palette (editor focused) excludes browseSs* editor commands",
      paletteWithFocusState.hasNoEditorBrowseCmds,
      paletteWithFocusState,
    );
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
    await page.waitForTimeout(300);
  }

  // -- Persistent Ace editor configuration -----------------------------------------
  // (a) a freshly-constructed adapter picks up whatever's seeded on ssExt.aceConfig
  // (mirrors sw.js's onUpdated seed) - probed directly against a scratch div rather
  // than round-tripping deactivate()/activate() on real SAS Studio tabs, which would
  // reuse the same container id ace.edit() caches an editor instance against.
  const seededTabSize = await page.evaluate(() => {
    window.__ssExt.aceConfig = {
      darkTheme: "ace/theme/gruvbox",
      lightTheme: "ace/theme/iplastic",
      options: { fontSize: 15, keyboardHandler: "ace/keyboard/vim", useSoftTabs: true, tabSize: 9 },
    };
    const div = document.createElement("div");
    div.id = "ssext_smoke_config_probe";
    document.body.appendChild(div);
    const adapter = new window.__ssExt.AceEditorAdapter(div.id, "", "sas");
    const tabSize = adapter.aceEditor.getOption("tabSize");
    adapter.dispose();
    div.remove();
    return tabSize;
  });
  check("adapter picks up seeded aceConfig for a new editor", seededTabSize === 9, { seededTabSize });

  // (b) applyAceConfig live-applies an option change to already-open adapters.
  await page.evaluate(() => {
    window.__ssExt.applyAceConfig({
      darkTheme: "ace/theme/gruvbox",
      lightTheme: "ace/theme/iplastic",
      options: { fontSize: 15, keyboardHandler: "ace/keyboard/vim", useSoftTabs: true, tabSize: 12 },
    });
  });
  const liveAppliedTabSize = await page.evaluate(() => {
    const tabObj = window.appDMS.tabs.getAllTabObjects().find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor);
    return tabObj ? tabObj.editor.editor.aceEditor.getOption("tabSize") : null;
  });
  check("applyAceConfig live-applies to already-open adapters", liveAppliedTabSize === 12, { liveAppliedTabSize });

  // (c) the stock settings menu (Ctrl-,/showSettingsMenu, no custom panel anymore)
  // opens for a focused editor via the real command, not a direct function call.
  const focusedForPrefs = await page.evaluate(async () => {
    const tabObj = window.appDMS.tabs.getAllTabObjects().find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor);
    if (!tabObj) return false;
    window.appDMS.tabs.selectTab(tabObj);
    const aceEditor = tabObj.editor.editor.aceEditor;
    aceEditor.focus();
    await new Promise((r) => setTimeout(r, 100));
    aceEditor.execCommand("showSettingsMenu");
    return true;
  });
  await page.waitForTimeout(300);
  const panelOpen = await page.evaluate(() => !!document.getElementById("ace_settingsmenu"));
  check("stock settings menu opens for a focused editor (execCommand)", focusedForPrefs && panelOpen, { focusedForPrefs, panelOpen });

  // (d) driving a real panel control (not calling setOption directly) persists to
  // chrome.storage.local.aceConfig via the OptionPanel.prototype.setOption hook + relay.js.
  let persistedAceConfig = null;
  if (panelOpen) {
    await page.evaluate(() => {
      const input = document.querySelector('#ace_settingsmenu input[type="number"]');
      input.value = "22";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(500);
    persistedAceConfig = await sw.evaluate(async () => {
      const { aceConfig } = await chrome.storage.local.get("aceConfig");
      return aceConfig || null;
    });
  }
  check(
    "settings menu control change persists via relay.js to chrome.storage.local.aceConfig",
    !!persistedAceConfig && persistedAceConfig.options && persistedAceConfig.options.fontSize === 22,
    persistedAceConfig,
  );
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(200);

  // (e) vimrc: pushing a config with a vimrc string through applyAceConfig applies
  // it against the (already-loaded, from the toggle above) vim module.
  const vimrcApplied = await page.evaluate(async () => {
    const before = window.__ssExt._vimrcApplied || 0;
    window.__ssExt.applyAceConfig({
      darkTheme: "ace/theme/gruvbox",
      lightTheme: "ace/theme/iplastic",
      options: { fontSize: 15, keyboardHandler: "ace/keyboard/vim", useSoftTabs: true, tabSize: 4 },
      vimrc: "imap jj <Esc>",
    });
    for (let i = 0; i < 30; i++) {
      if ((window.__ssExt._vimrcApplied || 0) > before) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { applied: (window.__ssExt._vimrcApplied || 0) > before, lastText: window.__ssExt._vimrcLastText };
  });
  check("vimrc applies via applyAceConfig", vimrcApplied.applied && vimrcApplied.lastText === "imap jj <Esc>", vimrcApplied);

  // Clean up storage state so reruns are deterministic.
  await sw.evaluate(() => chrome.storage.local.remove("aceConfig"));

  const deactivated = await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  check("Ace editor replacement deactivates cleanly", deactivated && deactivated.active === false, deactivated);

  // -- Global command-palette hotkey (Alt+Shift+P), Ace NOT activated ------------
  // Exercises sw.js's tabs.onUpdated pre-injection (editor-swap.js + seeded
  // ssExt.libPath/userSnippets) - the ss-fixes.js hotkey calls
  // window.__ssExt.commandPalette() with no args, so it only works if that
  // pre-injection already ran.
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", altKey: true, shiftKey: true, bubbles: true }),
    ),
  );
  await page.waitForTimeout(500);
  const hotkeyPaletteState = await page.evaluate(() => ({
    active: window.__ssExt.active,
    overlayPresent: !!document.querySelector(".ace_prompt_container"),
  }));
  check(
    "global Alt+Shift+P hotkey opens the command palette with Ace not activated",
    !hotkeyPaletteState.active && hotkeyPaletteState.overlayPresent,
    hotkeyPaletteState,
  );
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);

  // -- Minimizable run-progress dialog + single-run guard -------------------------
  const busyDialogState = await page.evaluate(async () => {
    // Pick a pre-existing code tab whose Run button is enabled - minimizing
    // must disable it (that's what blocks Run/F3 for tabs whose handlers were
    // dojo.hitch'd to the original submitHandler at construction), and run end
    // must re-enable it.
    const runTab = window.appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.submitButton && !t.editor.submitButton.get("disabled"));
    // Background submits run in separate SAS sessions - their button must NOT
    // be disabled by minimizing (only the foreground run is single-run).
    const bgTab = window.appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.backgroundSubmitButton && !t.editor.backgroundSubmitButton.get("disabled"));

    const dialog = window.appDMS.dialogs.postBusyDialog("Submitting SAS Code", () => {});
    // dijit._underlay.open is the authoritative flag (DialogUnderlay.show/hide);
    // its domNode is a wrapper separate from the .dijitDialogUnderlay inner node.
    const underlayBlockedBefore = !!(dijit._underlay && dijit._underlay.open);

    const btn = dialog.titleBar && dialog.titleBar.querySelector(".ssf-busy-dialog-minimize");
    if (!btn) return { hasMinimizeButton: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 100));

    const runButtonDisabledAfterMinimize = runTab ? runTab.editor.submitButton.get("disabled") === true : null;
    const bgButtonStillEnabledAfterMinimize = bgTab ? bgTab.editor.backgroundSubmitButton.get("disabled") === false : null;

    const underlayHiddenAfter = !dijit._underlay || dijit._underlay.open === false;
    const dialogStillInDom = !!document.getElementById(dialog.id);
    const dialogPinned = getComputedStyle(dialog.domNode).position === "fixed";

    // Single-run guard: a submitHandler on any open code tab must now refuse
    // to run (appDMS.dialogs.busyDialog is still set - the dialog is only
    // minimized, not destroyed) - verified via the specific client note the
    // guard sends instead of calling through to the real submit flow (which
    // would try to hit the network).
    const tabObj = window.appDMS.tabs.getAllTabObjects().find((t) => t.editor && t.editor.submitHandler);
    let guardRefused = null;
    if (tabObj) {
      let note = null;
      const origNote = window.appDMS.sendClientNoteMessage;
      window.appDMS.sendClientNoteMessage = (msg) => (note = msg);
      try {
        tabObj.editor.submitHandler();
      } finally {
        window.appDMS.sendClientNoteMessage = origNote;
      }
      guardRefused = typeof note === "string" && /already running/i.test(note);
    }

    // Destroy the (minimized) busy dialog, same as hideBusyDialog() at run end,
    // and confirm a later modal dialog still gets a working underlay - the
    // early DialogLevelManager.hide() call at minimize time must not have left
    // the shared stack/underlay singleton in a broken state.
    dialog.destroy();
    window.appDMS.dialogs.busyDialog = null;
    await new Promise((r) => setTimeout(r, 100));

    const runButtonReenabledAfterDestroy = runTab ? runTab.editor.submitButton.get("disabled") === false : null;

    const otherDialog = new dijit.Dialog({ title: "SS Ext smoke: post-minimize modality check" });
    otherDialog.show();
    await new Promise((r) => setTimeout(r, 200));
    const otherUnderlayShown = !!(dijit._underlay && dijit._underlay.open);
    otherDialog.destroy();

    return {
      hasMinimizeButton: true,
      underlayBlockedBefore,
      underlayHiddenAfter,
      dialogStillInDom,
      dialogPinned,
      hasTabToTestGuard: !!tabObj,
      guardRefused,
      hasRunTab: !!runTab,
      hasBgTab: !!bgTab,
      runButtonDisabledAfterMinimize,
      bgButtonStillEnabledAfterMinimize,
      runButtonReenabledAfterDestroy,
      otherUnderlayShown,
    };
  });
  check("busy dialog gets a minimize button in its title bar", busyDialogState.hasMinimizeButton, busyDialogState);
  if (busyDialogState.hasMinimizeButton) {
    check("busy dialog underlay blocks the app before minimizing", busyDialogState.underlayBlockedBefore, busyDialogState);
    check("minimizing releases the modal underlay", busyDialogState.underlayHiddenAfter, busyDialogState);
    check("minimized dialog stays visible (pinned) instead of closing", busyDialogState.dialogStillInDom && busyDialogState.dialogPinned, busyDialogState);
    check(
      busyDialogState.hasTabToTestGuard
        ? "single-run guard blocks submitHandler while busyDialog is set"
        : "single-run guard blocks submitHandler while busyDialog is set (skipped: no code tab open)",
      !busyDialogState.hasTabToTestGuard || busyDialogState.guardRefused === true,
      busyDialogState,
    );
    check(
      busyDialogState.hasRunTab
        ? "minimizing disables pre-existing tabs' Run buttons (blocks Run/F3 via DMSEditor's own disabled check)"
        : "minimizing disables pre-existing tabs' Run buttons (skipped: no enabled Run button open)",
      !busyDialogState.hasRunTab || busyDialogState.runButtonDisabledAfterMinimize === true,
      busyDialogState,
    );
    check(
      busyDialogState.hasBgTab
        ? "minimizing leaves background-submit buttons enabled (background runs stay allowed)"
        : "minimizing leaves background-submit buttons enabled (skipped: none enabled)",
      !busyDialogState.hasBgTab || busyDialogState.bgButtonStillEnabledAfterMinimize === true,
      busyDialogState,
    );
    check(
      busyDialogState.hasRunTab
        ? "run end (dialog destroy) re-enables the Run buttons it disabled"
        : "run end (dialog destroy) re-enables the Run buttons it disabled (skipped: no enabled Run button open)",
      !busyDialogState.hasRunTab || busyDialogState.runButtonReenabledAfterDestroy === true,
      busyDialogState,
    );
    check("a later modal dialog still gets a working underlay after the busy dialog is destroyed", busyDialogState.otherUnderlayShown, busyDialogState);
  }

  await ctx.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(1);
});
