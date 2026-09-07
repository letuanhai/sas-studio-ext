/**
 * End-to-end smoke test: loads the unpacked extension in Chromium against a live
 * SAS Studio instance and exercises the page-side features.
 *
 * Run:   npm run test:smoke   (or `npm run test` for units + smoke)
 * Setup: npm i && npx playwright install chromium
 * Env:   SS_URL      SAS Studio URL      (default http://sas-ue.lan/SASStudio/38/)
 *        CHROME_BIN  Chromium executable (default: playwright's bundled chromium)
 * Needs at least one closable FILE tab open in the SAS Studio session.
 *
 * Install `chromium` specifically: a bare `npx playwright install` also fetches
 * Firefox and WebKit, which nothing here launches and whose missing system
 * libraries produce a host-validation warning that reads like a real failure.
 * CHROME_BIN is only for pointing at some other build - playwright's own launcher
 * hardcodes a build number, so a `playwright` and a `~/.cache/ms-playwright/`
 * that disagree make the default `executablePath()` point at a build that isn't
 * there (`npx playwright install` after an `npm i` keeps them in step).
 * Don't use a real Chrome (e.g. `google-chrome-stable`) as CHROME_BIN: unlike
 * playwright's bundled Chromium, it silently fails to load `--load-extension` in
 * headless mode (chrome://extensions comes up empty, no error) even with
 * `--disable-extensions-except` and `ignoreDefaultArgs: ["--disable-extensions"]`.
 *
 * Also needs `lib/ace/src-noconflict/ace.js` and `lib/ace-linters/*.js` present
 * (`./tools/build_lib.sh`'s ace source build, ~1 min, and its `npm pack` of
 * ace-linters) or the Ace-activation tests fail on a 404. The much slower
 * `lib/sas-lsp` clone+webpack build is only needed for the LSP-specific checks;
 * everything else degrades gracefully (one console warning) without it.
 *
 * Middle-clicks are sent as raw CDP input (trusted, full event pipeline) - this is
 * what caught the dojo/touch.js dojoClick suppression bug that synthetic
 * dispatchEvent-based tests can't see.
 */
const { chromium } = require("playwright");
const { closeBrowser, armExitGuards } = require("../tools/browser-guard");

const EXT = require("path").resolve(__dirname, "..");
// A full run is a few minutes (it makes real SAS submissions). Past this, the
// run is stuck, not slow - and a stuck run is exactly how a headless Chromium
// gets left behind for hours.
const WATCHDOG_MS = 20 * 60 * 1000;
const URL = process.env.SS_URL || "http://sas-ue.lan/SASStudio/38/";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

// Every page load creates a workspace session on the server (2 sas_x processes,
// ~28 MB) and SAS Studio's own cleanup - a sync xhrDelete in its unload handler -
// has been dead since Chrome 80 blocked sync XHR on page dismissal. So the run
// has to release its own sessions, from a live page, before abandoning it: a
// reload abandons one, and so does closing the browser. Only ever delete ids
// this run created - the endpoint accepts any id, including a colleague's.
const releaseSession = async (page) => {
  const id = await page.evaluate(() => window.appDMS?.sessionId).catch(() => null);
  if (!id) return;
  await page
    .evaluate((id) => fetch(`./sasexec/sessions/${id}`, { method: "DELETE", credentials: "same-origin" }), id)
    .catch(() => {});
};

let ctx, page;
// Runs on every exit path, including a harness error, a signal and the watchdog -
// a leaked headless Chromium pings its session every 10s, so it never even goes
// idle for the server's timeout. Every step is bounded: releasing the session
// needs a live page, and the page being wedged is precisely the case that used
// to leave the browser running for good.
const shutdown = () => closeBrowser(ctx, () => page && releaseSession(page));

(async () => {
  armExitGuards(shutdown, WATCHDOG_MS);
  ctx = await chromium.launchPersistentContext("", {
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[SS Ext]") && m.type() === "error") console.log("PAGE ERROR:", t);
  });
  // ss-fixes is injected by sw.js and applies its patches once ".dijitTreeNode"
  // exists; the wrapped closeChild is the last-applied one, so waiting for it
  // beats a fixed sleep in both directions (faster here, and no flake on a slow
  // load). The settle after it is for SAS Studio's own tab restore.
  const waitForPatches = async () => {
    await page.waitForSelector(".dijitTreeNode", { state: "attached", timeout: 45000 });
    await page
      .waitForFunction(
        () => /__ssfClosedTabs/.test(String(window.dijit?.layout?.StackContainer?.prototype?.closeChild)),
        null,
        { timeout: 30000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1000);
  };

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await waitForPatches();

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
    closeChildWrapped: /__ssfClosedTabs/.test(String(window.dijit.layout.StackContainer.prototype.closeChild)),
    tabCount: window.appDMS.tabs.getAllTabObjects().length,
  }));
  check("ss-fixes injected and initialized", state.initialized && state.toolsMeta, state);
  check("reopenClosedTab tracking installed", state.closedTabsTracking && state.closeChildWrapped, state);

  // -- confirmDropFile asks once per drop, not once per item ----------------------
  // dijit pastes every dragged node in one synchronous forEach, so two pasteItem
  // calls in the same tick are one drop. Declining keeps this from touching the
  // server: the original pasteItem only runs on a yes.
  const dropState = await page.evaluate(async () => {
    const store = window.appDMS.projects.projectTreeStore;
    const original = window.confirm;
    let asked = 0;
    let message = "";
    window.confirm = (m) => {
      asked++;
      message = m;
      return false; // decline - nothing is moved
    };
    const item = (uri) => ({ uri, isDirectory: false });
    const target = { uri: "/folders/myfolders/ssext-smoke-target" };
    try {
      store.pasteItem(item("/folders/myfolders/a.sas"), target, target, false, undefined);
      store.pasteItem(item("/folders/myfolders/b.sas"), target, target, false, undefined);
      const perDrop = asked;
      await new Promise((r) => setTimeout(r, 0)); // next tick = next drop
      store.pasteItem(item("/folders/myfolders/c.sas"), target, target, false, undefined);
      return { perDrop, nextDrop: asked, message };
    } finally {
      window.confirm = original;
    }
  });
  check(
    "drag-and-drop move asks once per drop, and again for the next one",
    dropState.perDrop === 1 && dropState.nextDrop === 2,
    dropState,
  );
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

    // -- the tab's own X button is tracked too (it never calls tabs.closeTab) -----
    const xClosed = await page.evaluate(async () => {
      const t = window.appDMS.tabs.getAllTabObjects().find((t) => t.type === "FILE");
      if (!t) return null;
      const btn = (t.tab ?? t).controlButton.domNode.querySelector("[class*=Close]");
      if (!btn) return null;
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { name: t.name, stack: window.__ssfClosedTabs.map((c) => c.name) };
    });
    check("X-button close is tracked for reopen", !!xClosed && xClosed.stack.includes(xClosed.name), xClosed);
    if (xClosed) {
      await page.evaluate(() => window.__ssf.run("reopenClosedTab"));
      await page.waitForTimeout(2500);
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

  // ss-fixes loads OUR ace at page load, with the toggle still off. It lives on
  // window.__ssAce (tools/build_lib.sh renames the vendored build's module-registry
  // namespace); SAS Studio's own 1.x build keeps window.ace to itself. The
  // checks below guard the two failure modes sharing one global caused: our
  // modules landing in SAS's registry (which is how vim's :w/:q/:wq/:x once
  // silently vanished) and SAS's stock editor ending up on our build.
  const preload = await page.evaluate(async (lp) => {
    await window.__ssExt.loadNewAce(lp); // no-op if the page-load load already ran
    const req = (ace) => {
      try {
        const m = ace.require("ace/keyboard/vim");
        return !!(m && m.Vim);
      } catch (e) {
        return false;
      }
    };
    // Force a LAZY module load (a theme nothing has asked for yet) and check
    // which registry it lands in - the property the whole split exists for.
    const lazyTheme = await new Promise((resolve) => {
      window.__ssAce.config.loadModule("ace/theme/monokai", () => {
        resolve({
          inOurs: !!window.__ssAce.require("ace/theme/monokai").cssClass,
          inSas: (() => {
            try {
              return !!window.ace.require("ace/theme/monokai");
            } catch (e) {
              return false;
            }
          })(),
        });
      });
    });
    return {
      active: window.__ssExt.active,
      separateLibs: window.ace !== window.__ssAce && window.__ssAce === window.__ssExt.newLib.ace,
      sasAceVersion: window.ace.version,
      ourAceVersion: window.__ssAce.version,
      // SAS's stock editor tokenizes through ITS OWN build, at call time, in
      // exactly these places (paths under SAS Studio's own
      // resources/js/sas-commons/controls/_codeEditor/):
      //   mode/SyntaxColorerAdapter.js  ace/edit_session .EditSession
      //   Mode.js                       ace/lib/oop .inherits, ace/mode/text .Mode,
      //                                 ace/mode/text_highlight_rules .TextHighlightRules
      //   mode/sas/SasLexer.js          ace/unicode .packages
      // All of it must still resolve off window.ace - if it stops, our ace has
      // leaked into SAS's registry (or evicted it) and the stock editor silently
      // stops colouring.
      sasContractBroken: Object.entries({
        "ace/edit_session .EditSession": () => !!window.ace.require("ace/edit_session").EditSession,
        "ace/lib/oop .inherits": () => typeof window.ace.require("ace/lib/oop").inherits === "function",
        "ace/mode/text .Mode": () => !!window.ace.require("ace/mode/text").Mode,
        "ace/mode/text_highlight_rules .TextHighlightRules": () =>
          !!window.ace.require("ace/mode/text_highlight_rules").TextHighlightRules,
        "ace/unicode .packages": () => !!(window.ace.require("ace/unicode").packages || {}).L,
      })
        .filter(([, probe]) => {
          try {
            return !probe();
          } catch (e) {
            return true;
          }
        })
        .map(([name]) => name),
      lazyTheme,
      vimExInstalled: !!window.__ssExt._vimExInstalled,
      inNewAce: req(window.__ssAce),
      inOldAce: req(window.ace),
    };
  }, libPath);
  check(
    "our ace and SAS's are two separate libraries, SAS's untouched on window.ace",
    preload.separateLibs && preload.sasAceVersion !== preload.ourAceVersion && !preload.active,
    preload,
  );
  check(
    "SAS's stock editor still resolves everything it needs from its OWN ace",
    preload.sasContractBroken.length === 0,
    preload,
  );
  check(
    "a lazily loaded module registers in OUR registry, not SAS's",
    preload.lazyTheme.inOurs && !preload.lazyTheme.inSas,
    preload,
  );
  check(
    "vim ex-commands install against our ace, not SAS's build",
    preload.vimExInstalled && preload.inNewAce && !preload.inOldAce,
    preload,
  );

  const activated = await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  check("Ace editor replacement activates", activated && activated.active === true, activated);

  // The createCodeEditor dispatcher must be installed even when the session
  // restored with no code tab to take the DMSEditor class off - otherwise every
  // tab opened afterwards silently gets SAS Studio's own editor. Deliberately
  // not gated on a code tab existing: that gate is what hid this.
  const dispatcher = await page.evaluate(() => {
    let cls = null;
    try {
      cls = window.require("webdms/DMSEditor");
    } catch {}
    return {
      patched: !!(cls && cls.prototype._aceReplacementPatched),
      saved: !!window.__ssExt.originalCreateCodeEditor,
      codeTabs: window.appDMS.tabs.getAllTabObjects().filter((t) => t.editor).length,
    };
  });
  check("createCodeEditor dispatcher installed (even with no code tab)", dispatcher.patched && dispatcher.saved, dispatcher);

  // Everything below that needs a focused Ace code editor used to skip itself
  // whenever the session restored without one - six checks, quietly. Open one
  // instead. It has to be a real saved .sas file, not appDMS.onNewProgram(): a
  // new program is empty (so "non-virgin" checks still skip) and has no uri (so
  // the Alt+C copy-tab-uri check has nothing to copy). Opening it also checks
  // end to end that the dispatcher above really is in place.
  if (!dispatcher.codeTabs) {
    const opened = await page.evaluate(async () => {
      const a = window.appDMS;
      const root = "/folders/myfolders";
      const url =
        a.baseURL + "/sasexec/sessions/" + a.sessionId + "/workspace/" + encodeValue(root) + "?includeChildren=true";
      const children = await new Promise((res) => {
        dojo.xhrGet({
          url,
          handleAs: "json",
          preventCache: true,
          load: (d) => res((d && d[0] && d[0].children) || []),
          error: () => res([]),
        });
      });
      const f = children.find((c) => c.size && Number(c.size) > 0 && /\.sas$/i.test(c.name));
      if (!f) return { found: false };
      const uri = `${root}/${f.name}`;
      // id backfill: handleWebOneEvent only derives it for some actions, and an
      // id-less item opens as tab id "undefined" (see ext-browse_ss's openItemInSs).
      a.handleWebOneEvent("FileOpen", { uri, name: f.name, id: uri.replaceAll("/", "~ps~"), type: "FILE" });
      await new Promise((r) => setTimeout(r, 6000));
      const t = a.tabs.getAllTabObjects().find((t) => t.uri === uri);
      const ed = t && t.editor && t.editor.editor;
      return {
        found: true,
        name: f.name,
        isAdapter: !!(ed && ed._isAceEditorAdapter),
        lines: ed && ed.aceEditor ? ed.aceEditor.session.getLength() : 0,
      };
    });
    check(
      "a .sas file opens as an Ace code tab when the session restored without one",
      opened.found && opened.isAdapter && opened.lines > 1,
      opened,
    );
  }

  // -- stray scrolling (SurfingKeys) -----------------------------------------------
  // The gutter/scroller must not be scroll containers: anything that scrolls by
  // feel (SurfingKeys picks the gutter, and even writes scrollTop to probe it)
  // would otherwise slide the line numbers out of step with the text.
  const scrollPin = await page.evaluate(() => {
    const el = document.querySelector(".ace_editor .ace_gutter");
    const sc = document.querySelector(".ace_editor .ace_scroller");
    if (!el || !sc) return { found: false };
    el.scrollTop = 80;
    sc.scrollTop = 80;
    return { found: true, gutter: el.scrollTop, scroller: sc.scrollTop };
  });
  check(
    "gutter/scroller cannot be scrolled out of sync",
    scrollPin.found && scrollPin.gutter === 0 && scrollPin.scroller === 0,
    scrollPin,
  );

  // -- Unsaved-change gutter -------------------------------------------------------
  // Runs on a detached adapter: the marks are per-editor and need no SAS tab. Also
  // the guard that ext-diff.js (the line differ) actually loaded - dirtyRows()
  // swallows a missing module and returns no marks at all.
  const dirtyGutter = await page.evaluate(() => {
    const div = document.createElement("div");
    div.id = "ssext_smoke_dirty";
    div.style.cssText = "position:absolute;left:-9999px;top:0;width:400px;height:300px";
    document.body.appendChild(div);
    const adapter = new window.__ssExt.AceEditorAdapter(div.id, "one\ntwo\nthree\nfour", "sas");
    const rows = () => (adapter._dirtyRows || []).map((d) => `${d.row}:${d.cls}`);
    const doc = adapter.aceEditor.session.doc;

    const clean = rows();
    doc.insert({ row: 1, column: 3 }, " changed");
    adapter._refreshDirtyGutter();
    const edited = rows();

    doc.removeFullLines(3, 3);
    adapter._refreshDirtyGutter();
    const deleted = rows();

    adapter.aceEditor.renderer.updateFull(true);
    const markedCells = [...div.querySelectorAll(".ace_gutter-cell")].filter((c) =>
      /ssExtDirty/.test(c.className),
    ).length;

    adapter.markSaved();
    const saved = rows();
    adapter.aceEditor.renderer.updateFull(true);
    const cellsAfterSave = [...div.querySelectorAll(".ace_gutter-cell")].filter((c) =>
      /ssExtDirty/.test(c.className),
    ).length;

    adapter.dispose();
    div.remove();
    return { clean, edited, deleted, markedCells, saved, cellsAfterSave };
  });
  check("unsaved-change gutter: unedited content has no marks", dirtyGutter.clean.length === 0, dirtyGutter);
  check(
    "unsaved-change gutter: an edited line is marked, and only it",
    JSON.stringify(dirtyGutter.edited) === JSON.stringify(["1:ssExtDirty"]),
    dirtyGutter,
  );
  check(
    "unsaved-change gutter: a deleted line leaves a deletion mark",
    dirtyGutter.deleted.some((r) => r.endsWith(":ssExtDirtyDel")) &&
      dirtyGutter.deleted.includes("1:ssExtDirty"),
    dirtyGutter,
  );
  check("unsaved-change gutter: marks reach the gutter cells", dirtyGutter.markedCells >= 2, dirtyGutter);
  check(
    "unsaved-change gutter: saving clears the marks",
    dirtyGutter.saved.length === 0 && dirtyGutter.cellsAfterSave === 0,
    dirtyGutter,
  );

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

  // -- LSP semantic-token markers stay bounded (installLspMarkerPatches) -----------
  // ace-linters creates one ace text marker per semantic token for the whole
  // document on every edit/scroll, and never compacts the id-indexed store, which
  // made large files slower and slower the longer the page stayed open. Both are
  // patched: markers must cover roughly the viewport, not the file, and the store
  // must not grow without bound across edits.
  if (lspState.hasProvider) {
    const markerState = await page.evaluate(async () => {
      window.__ssExt.aceConfig = { lsp: true, lspMaxLines: 0 };
      const text = Array.from(
        { length: 800 },
        (_, i) => `data work.t${i}; set sashelp.class; x${i} = age * ${i}; run;`,
      ).join("\n");
      const div = document.createElement("div");
      div.id = "ssext_smoke_lsp_markers";
      div.style.cssText = "position:fixed;left:0;top:0;width:800px;height:400px;z-index:99999";
      document.body.appendChild(div);
      const a = new window.__ssExt.AceEditorAdapter(div.id, text, "sas");
      const session = a.aceEditor.session;
      const live = () => {
        let n = 0;
        (session.$textMarkers || []).forEach(() => n++);
        return n;
      };
      for (let i = 0; i < 60; i++) {
        if (live() > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const afterFirst = live();
      // Edit repeatedly: each round re-requests + re-creates the whole marker set.
      for (let round = 0; round < 25; round++) {
        a.aceEditor.insert("x");
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 2000));
      const state = {
        afterFirst,
        afterEdits: live(),
        storeLength: (session.$textMarkers || []).length,
        // These separate "the perf patch regressed" from "the server answered
        // nothing this run", which look identical from the counts alone.
        markerPatched: !!window.__ssExt._lspMarkerPatched,
        registered: !!a._lspRegistered,
      };
      a.dispose();
      div.remove();
      return state;
    });
    check(
      "semantic-token markers cover the viewport, not the whole file",
      markerState.afterFirst > 0 && markerState.afterFirst < 3000,
      markerState,
    );
    check(
      "the text-marker store stays bounded across many edits",
      markerState.storeLength < 20000,
      markerState,
    );
  }

  // -- Library/table names for LSP completion (sas/getLibList) ---------------------
  // What the SAS language server asks the client for. Exercised directly (no LSP
  // bundle needed): the list must come back in LibCompleteItem shape, a library's
  // id must round-trip as the next lookup's libId, and SAS Studio's own library
  // refresh must drop the cache so a new LIBNAME shows up.
  const libListState = await page.evaluate(async () => {
    const libs = await window.__ssExt._getLibList(null);
    const lib = libs.find((l) => l.name.toUpperCase() === "SASHELP") || libs[0];
    const tables = lib ? await window.__ssExt._getLibList(lib.id) : [];
    const cachedBefore = window.__ssExt._libListCache.size;
    window.appDMS.libraries.onRefresh();
    return {
      libCount: libs.length,
      allLibraries: libs.every((l) => l.type === "LIBRARY" && !!l.id && !!l.name),
      lib: lib && lib.id,
      tableCount: tables.length,
      allTables: tables.every((t) => (t.type === "DATA" || t.type === "VIEW") && !!t.name),
      cachedBefore,
      cachedAfterRefresh: window.__ssExt._libListCache.size,
    };
  });
  check(
    "sas/getLibList returns the libraries as LibCompleteItems",
    libListState.libCount > 0 && libListState.allLibraries,
    libListState,
  );
  check(
    "a library's id lists that library's tables",
    libListState.tableCount > 0 && libListState.allTables,
    libListState,
  );
  check(
    "a library-tree refresh invalidates the cached lists",
    libListState.cachedBefore > 0 && libListState.cachedAfterRefresh === 0,
    libListState,
  );

  // -- LSP completions actually reach the popup, and reach it first ----------------
  // Both halves of this were silently broken at some point: the score-dampening
  // workaround also dampened ace-linters' own completer (so LSP entries sank below
  // plain text words), and registerEditor's push leaked into ext-language_tools'
  // shared completers array (so every later editor carried duplicate LSP completers).
  if (lspState.hasProvider) {
    const lspCompletionState = await page.evaluate(async () => {
      window.__ssExt.aceConfig = Object.assign({}, window.__ssExt.aceConfig, {
        lsp: true,
        lspMaxLines: 0,
      });
      const div = document.createElement("div");
      div.id = "ssext_smoke_lsp_completion";
      div.style.cssText = "position:fixed;left:0;top:0;width:800px;height:300px;z-index:99999";
      document.body.appendChild(div);
      const a = new window.__ssExt.AceEditorAdapter(div.id, "", "sas");
      const ed = a.aceEditor;
      for (let i = 0; i < 40; i++) {
        if (a._lspRegistered) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      ed.setValue("data test;\n  set sashelp.", -1);
      ed.focus();
      ed.navigateFileEnd();
      await new Promise((r) => setTimeout(r, 1500));
      ed.execCommand("startAutocomplete");
      let top = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const c = ed.completer && ed.completer.completions;
        if (c && c.filtered && c.filtered.length) {
          top = c.filtered.slice(0, 5).map((x) => x.completerId);
          break;
        }
      }
      // A fresh editor must not inherit an LSP completer from the one above.
      const div2 = document.createElement("div");
      div2.id = "ssext_smoke_lsp_completion_fresh";
      div2.style.cssText = "position:fixed;left:-9999px;top:0;width:400px;height:200px";
      document.body.appendChild(div2);
      const b = new window.__ssExt.AceEditorAdapter(div2.id, "x", "ace/mode/text");
      const leaked = b.aceEditor.completers.filter((c) => c.id === "lspCompleters").length;
      [
        [b, div2],
        [a, div],
      ].forEach(([adapter, node]) => {
        adapter.dispose();
        node.remove();
      });
      return { registered: a._lspRegistered, top, leaked };
    });
    check(
      "LSP completions (library/table names) rank above the text completers",
      lspCompletionState.top.length > 0 &&
        lspCompletionState.top.every((id) => id === "lspCompleters"),
      lspCompletionState,
    );
    check(
      "registering with the LSP doesn't leak completers into ace's shared list",
      lspCompletionState.leaked === 0,
      lspCompletionState,
    );
  }

  // -- Completion from the other open editors --------------------------------------
  // Words defined in one editor must be offered in another, and must follow edits.
  // A registers as a text viewer (what allAdapters() walks) so this needs no second
  // server-backed tab.
  const otherEditorsState = await page.evaluate(async () => {
    const mk = (id, text) => {
      const div = document.createElement("div");
      div.id = id;
      div.style.cssText = "position:fixed;left:-9999px;top:0;width:400px;height:200px";
      document.body.appendChild(div);
      return { div, adapter: new window.__ssExt.AceEditorAdapter(id, text, "sas") };
    };
    const a = mk("ssext_smoke_words_a", "data zzqqmarker; set sashelp.class; run;");
    const b = mk("ssext_smoke_words_b", "data zzqqownword; run;");
    const entry = { adapter: a.adapter };
    window.__ssExt._textViewers.push(entry);

    const editor = b.adapter.aceEditor;
    const completer = editor.completers.find((c) => c.id === "ssextOtherEditors");
    const complete = () =>
      new Promise((res) =>
        completer.getCompletions(editor, editor.session, { row: 0, column: 0 }, "", (e, r) =>
          res((r || []).map((x) => x.value)),
        ),
      );

    const words = completer ? await complete() : [];
    a.adapter.aceEditor.session.insert({ row: 0, column: 0 }, "zzqqedited ");
    const afterEdit = completer ? await complete() : [];

    window.__ssExt._textViewers.splice(window.__ssExt._textViewers.indexOf(entry), 1);
    [a, b].forEach((x) => {
      x.adapter.dispose();
      x.div.remove();
    });
    return {
      registered: !!completer,
      hasOtherWord: words.includes("zzqqmarker"),
      hasOwnWord: words.includes("zzqqownword"),
      followsEdits: afterEdit.includes("zzqqedited"),
    };
  });
  check(
    "another editor's words are offered as completions, its own are not",
    otherEditorsState.registered &&
      otherEditorsState.hasOtherWord &&
      !otherEditorsState.hasOwnWord,
    otherEditorsState,
  );
  check(
    "the other editor's word cache follows its edits",
    otherEditorsState.followsEdits,
    otherEditorsState,
  );

  // -- SAS context completion: step parsing ----------------------------------------
  // Pure logic, no server: which tables a step reads, and where a step ends.
  const parseState = await page.evaluate(() => {
    const { tableRefs, stepAroundCursor, tableMeta } = window.__ssExt._sasContext;
    const refs = (t) => tableRefs(t).map((r) => `${r.lib || ""}|${r.table}|${r.alias || ""}`);
    // stepAroundCursor takes a session, so drive it through a throwaway editor.
    const div = document.createElement("div");
    div.id = "ssext_smoke_step_parse";
    div.style.cssText = "position:fixed;left:-9999px;top:0;width:400px;height:200px";
    document.body.appendChild(div);
    const a = new window.__ssExt.AceEditorAdapter(div.id, "", "sas");
    const stepAt = (marked) => {
      const head = marked.slice(0, marked.indexOf("|")).split("\n");
      a.aceEditor.setValue(marked.replace("|", ""), -1);
      return stepAroundCursor(a.aceEditor.session, {
        row: head.length - 1,
        column: head[head.length - 1].length,
      }).step;
    };
    const out = {
      sqlAlias: refs("proc sql; select * from sashelp.class a join work.b as c on 1"),
      notAnAlias: refs("proc sql; select * from sashelp.class where x"),
      dataStep: refs("data t; merge one two; set sashelp.class end=eof;"),
      procData: refs("proc print data = sashelp.cars;"),
      betweenSteps: stepAt("data t; set sashelp.class; run;\n|"),
      // The table is named AFTER the caret here - the step must reach past it.
      lookahead: stepAt("proc sql;\n  select | from sashelp.class;"),
      stopsAtNextStep: stepAt("proc sql;\n  select | from a.b;\nquit;\ndata z; set sashelp.cars;"),
      meta: [tableMeta("class"), tableMeta("a_very_long_table_name")],
    };
    a.dispose();
    div.remove();
    return out;
  });
  check(
    "step parsing finds tables, aliases and data-step lists",
    JSON.stringify(parseState.sqlAlias) === '["sashelp|class|a","work|b|c"]' &&
      JSON.stringify(parseState.notAnAlias) === '["sashelp|class|"]' &&
      JSON.stringify(parseState.dataStep) === '["|one|","|two|","sashelp|class|"]' &&
      JSON.stringify(parseState.procData) === '["sashelp|cars|"]',
    parseState,
  );
  check(
    "the step spans past the caret, ends at run;/quit;, and metas are capped",
    parseState.betweenSteps === "" &&
      /sashelp\.class/.test(parseState.lookahead) &&
      !/sashelp\.cars/.test(parseState.stopsAtNextStep) &&
      JSON.stringify(parseState.meta) === '["CLASS.","A_VERY_LONG…."]',
    parseState,
  );

  // -- SAS context completion: tables and columns ----------------------------------
  // PROC SQL data set names (the language server has no dataSet-typed option for
  // FROM) and column names (it has no column zone at all), both from SAS Studio's
  // own library tree. The first call only warms the caches - by design, the popup
  // never waits on a round trip - so each context is asked twice.
  const contextState = await page.evaluate(async () => {
    const div = document.createElement("div");
    div.id = "ssext_smoke_sas_context";
    div.style.cssText = "position:fixed;left:-9999px;top:0;width:600px;height:300px";
    document.body.appendChild(div);
    const a = new window.__ssExt.AceEditorAdapter(div.id, "", "sas");
    const ed = a.aceEditor;
    const completer = ed.completers.find((c) => c.id === "ssextSasContext");

    // "|" marks the cursor.
    const ask = (marked) => {
      const before = marked.slice(0, marked.indexOf("|")).split("\n");
      const pos = { row: before.length - 1, column: before[before.length - 1].length };
      ed.setValue(marked.replace("|", ""), -1);
      ed.moveCursorTo(pos.row, pos.column);
      return new Promise((res) =>
        completer.getCompletions(ed, ed.session, pos, "", (e, r) => res(r || [])),
      );
    };
    const askTwice = async (text) => {
      await ask(text);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const r = await ask(text);
        if (r.length) return r;
      }
      return [];
    };

    const libs = await askTwice("proc sql;\n  select * from |");
    const tables = await askTwice("proc sql;\n  select * from sashelp.|");
    const cols = await askTwice("proc sql;\n  select | from sashelp.class;");
    const scoped = await askTwice("proc sql;\n  select class.| from sashelp.class;");
    const atStart = await ask("data t;\n  set sashelp.class;\n  k|");
    const dataStepCols = await askTwice("data t;\n  set sashelp.class;\n  if | then;");

    a.dispose();
    div.remove();
    const names = (r) => r.map((x) => x.caption.toUpperCase());
    return {
      registered: !!completer,
      libs: { has: names(libs).includes("SASHELP"), meta: (libs[0] || {}).meta },
      tables: { has: names(tables).includes("CLASS"), meta: (tables[0] || {}).meta },
      cols: { names: names(cols).filter((n) => n === "AGE" || n === "SEX"), meta: (cols[0] || {}).meta },
      scoped: names(scoped).includes("AGE"),
      dataStepCols: names(dataStepCols).includes("AGE"),
      atStart: atStart.length,
    };
  });
  check(
    "PROC SQL offers libraries after FROM, tables after a libref",
    contextState.registered &&
      contextState.libs.has &&
      contextState.libs.meta === "library" &&
      contextState.tables.has &&
      contextState.tables.meta === "SASHELP.",
    contextState,
  );
  check(
    "columns of the step's tables are offered, labelled with the table",
    contextState.cols.names.length === 2 &&
      contextState.cols.meta === "CLASS." &&
      contextState.scoped &&
      contextState.dataStepCols,
    contextState,
  );
  check(
    "no columns at the start of a statement (a keyword belongs there)",
    contextState.atStart === 0,
    contextState,
  );

  // -- Meta labels on the language server's own completions ------------------------
  // The server kinds everything Folder (libraries) or Keyword (tables, the
  // program's own data set names, plain keywords), which ace-linters renders as
  // "Folder"/"Keyword". Driven directly with the two response shapes the server
  // actually produces - the caches it needs were filled by the getLibList checks
  // above. (Deliberately not another live LSP editor: the labels are cosmetic and
  // this costs nothing.)
  const metaState = await page.evaluate(() => {
    const { relabelLspCompletions } = window.__ssExt._sasContext;
    const item = (caption, kind) => ({ caption, meta: kind === 19 ? "Folder" : "Keyword", item: { kind } });
    const metaOf = (results, caption) => (results.find((r) => r.caption === caption) || {}).meta;

    // `set |` - the server answers with the libraries plus data set names it
    // parsed out of the program itself.
    const libraryZone = [item("SASHELP", 19), item("WORK", 19), item("t", 14)];
    relabelLspCompletions(libraryZone, { getLine: () => "  set " }, { row: 0, column: 6 });

    // `set sashelp.|` - all tables, no libraries.
    const tableZone = [item("CLASS", 14), item("CARS", 14)];
    relabelLspCompletions(tableZone, { getLine: () => "  set sashelp." }, { row: 0, column: 14 });

    // A plain keyword next to a libref-shaped prefix must not be mislabelled.
    const keywordZone = [item("length", 14)];
    relabelLspCompletions(keywordZone, { getLine: () => "  x = sashelp." }, { row: 0, column: 14 });

    // `%le|` - macro function labels carry the % the server matched, so the
    // insert has to replace the typed one instead of stacking a second %.
    const macroZone = [item("%LENGTH", 3), item("%LEFT", 3)];
    relabelLspCompletions(macroZone, { getLine: () => "  %le" }, { row: 0, column: 5 });

    return {
      macroRange: JSON.stringify(macroZone[0].range),
      library: metaOf(libraryZone, "SASHELP"),
      program: metaOf(libraryZone, "t"),
      table: metaOf(tableZone, "CLASS"),
      keyword: metaOf(keywordZone, "length"),
    };
  });
  check(
    "language-server entries are labelled library / <LIBREF>. / program, macro % replaced",
    metaState.library === "library" &&
      metaState.table === "SASHELP." &&
      metaState.program === "program" &&
      metaState.keyword === "Keyword" &&
      metaState.macroRange ===
        JSON.stringify({ start: { row: 0, column: 2 }, end: { row: 0, column: 5 } }),
    metaState,
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
    // Baseline, not zero: activate() converts text viewers that already exist -
    // a .txt/.log tab restored at app start is a legitimate registry entry that
    // this test neither created nor closes.
    const viewersBefore = await page.evaluate(() => window.__ssExt._textViewers.length);
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

      // Identify what is left over: an entry whose tabHolder no longer belongs to
      // any open tab is a real leak, one that still has a tab is a viewer this
      // test didn't open (see viewersBefore above).
      const afterClose = await page.evaluate(() => {
        const tabs = window.appDMS.tabs.getAllTabObjects();
        return {
          count: window.__ssExt._textViewers.length,
          entries: window.__ssExt._textViewers.map((e) => {
            const tab = tabs.find((t) => t.tab && t.tab.tabHolder === e.tabHolder);
            return {
              tabId: (tab && tab.tab.id) || null, // null => stale, the tab is gone
              name: (e.item && e.item.name) || (tab && tab.name) || null,
            };
          }),
        };
      });
      check("registry entry cleaned up on tab close", afterClose.count === viewersBefore, {
        ...afterClose,
        viewersBefore,
      });
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

  // Resizable prompt: dragging the box's handle writes an inline width (the list
  // follows it), dragging the list's writes an inline height - which ace would
  // undo on its next autosize if installResizablePopups didn't turn it back into
  // $maxLines/$minLines. Setting the inline styles here is exactly what the UA's
  // own resize does.
  const resized = await page.evaluate(() => {
    const box = document.querySelector(".ace_prompt_container");
    const pop = box.querySelector(".ace_autocomplete");
    const before = { boxW: box.offsetWidth, popH: pop.offsetHeight };
    box.style.width = "900px";
    pop.style.height = pop.offsetHeight + 250 + "px";
    return new Promise((r) =>
      setTimeout(
        () =>
          r({
            before,
            boxW: box.offsetWidth,
            popW: pop.offsetWidth,
            popH: pop.offsetHeight,
            maxLines: pop.__ssExtRenderer.$maxLines,
            lines: pop.__ssExtLines,
          }),
        600,
      ),
    );
  });
  check("resized palette list keeps the dragged height", resized.popH > resized.before.popH + 200, resized);
  check("dragged height became $maxLines", resized.maxLines === resized.lines && resized.lines > 15, resized);
  check("resized palette list follows the box width", Math.abs(resized.popW - resized.boxW) < 10, resized);
  // Put it back: the dragged size is remembered for the rest of the page
  // session, and the palette checks below expect the stock one.
  await page.evaluate((before) => {
    const box = document.querySelector(".ace_prompt_container");
    box.style.width = before.boxW - 6 + "px";
    box.querySelector(".ace_autocomplete").style.height = before.popH + "px";
  }, resized.before);
  await page.waitForTimeout(600);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);
  const paletteClosedAfterEsc = await page.evaluate(() => !document.querySelector(".ace_prompt_container"));
  check("command palette closes on Esc", paletteClosedAfterEsc, { paletteClosedAfterEsc });

  // Command history: recently-used commands are moved to the front of the
  // list in MRU order (deduped - moved, not copied); editor-only commands in
  // the history (here "gotoline") don't show up in the unfocused/global
  // palette, whose entries never include them.
  await page.evaluate((lp) => {
    window._browseSsStore.set(
      "SsCmdPaletteHistory",
      ["ssext:browseTabs", "gotoline", "ssext:browseFiles"],
    );
    window.__ssExt.commandPalette(lp);
  }, libPath);
  // getCompletions renders async (prompt's FilteredList pass) - wait for the
  // first completion row to actually reflect the MRU reorder rather than a
  // fixed sleep. ".ace_autocomplete .ace_line" (not just ".ace_line", which
  // also matches the empty cmdLine text-input's own line) - the completion
  // popup and the cmdLine are separate nested Ace editors.
  await page
    .waitForFunction(
      () => document.querySelector(".ace_prompt_container .ace_autocomplete .ace_line")?.textContent?.includes("Browse tabs"),
      null,
      { timeout: 3000 },
    )
    .catch(() => {});
  const paletteHistoryState = await page.evaluate(() => {
    const list = window.__ssCmdPalette_lastList || [];
    const popup = document.querySelector(".ace_prompt_container .ace_autocomplete");
    return {
      mruOrder: list[0]?.command === "ssext:browseTabs" && list[1]?.command === "ssext:browseFiles",
      deduped: list.filter((c) => c.command === "ssext:browseTabs").length === 1,
      noEditorCommand: !list.some((c) => c.command === "gotoline"),
      firstRowIsRecent: !!(popup && (popup.querySelector(".ace_line") || {}).textContent?.includes("Browse tabs")),
    };
  });
  check("command palette recent commands lead in MRU order", paletteHistoryState.mruOrder, paletteHistoryState);
  check("command palette recent commands are deduped", paletteHistoryState.deduped, paletteHistoryState);
  check("command palette (no focus) hides editor commands from history", paletteHistoryState.noEditorCommand, paletteHistoryState);
  check("command palette last-run command renders first", paletteHistoryState.firstRowIsRecent, paletteHistoryState);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);

  // browseFiles action opens the browse_ss prompt (its own container).
  await page.evaluate(() => window.__ssf.run("browseFiles"));
  await page.waitForTimeout(600);
  const browseOpened = await page.evaluate(() => !!document.querySelector(".ace_browse_ss_container"));
  check("browseFiles action opens the file browser prompt", browseOpened, { browseOpened });

  // Bookmarks: Ctrl+B toggles a bookmark on the selected entry (persisted in
  // chrome.storage via relay.js, key = historyKey + "Bookmarks"). Wait for the
  // popup to have data via the _browseSsLastPrompt debug handle; setData leaves
  // the first row selected, so only press Down when nothing is selected
  // (pressing it on a selected last row would wrap the selection back to -1,
  // ace's stock popup behavior). The in-memory cache (_browseSsStore) is
  // populated by then (updateCompletions awaits it before setData).
  await page
    .waitForFunction(() => window._browseSsLastPrompt?.popup?.data?.length > 0, null, { timeout: 10000 })
    .catch(() => {});
  await page.evaluate(() =>
    window._browseSsStore.set(`browseSs:${location.host}:BrowseSsFilesHistoryBookmarks`, [])
  );
  const selectRowThen = async (key) => {
    const rowSelected = await page.evaluate(() => window._browseSsLastPrompt.popup.getRow() >= 0);
    if (!rowSelected) await page.keyboard.press("ArrowDown");
    await page.keyboard.press(key);
  };
  await selectRowThen("Control+b");
  const bookmarkCount = () =>
    page.evaluate(
      () => (window._browseSsStore?.get(`browseSs:${location.host}:BrowseSsFilesHistoryBookmarks`) ?? []).length
    );
  const afterAdd = await bookmarkCount();
  check("Ctrl+B bookmarks the selected browse entry", afterAdd === 1, { afterAdd });
  await page.waitForTimeout(300); // toggle refreshes the popup async
  await selectRowThen("Control+b");
  const afterRemove = await bookmarkCount();
  check("Ctrl+B again removes the bookmark", afterRemove === 0, { afterRemove });

  // Copy keybindings (Alt+C name / Alt+Shift+C path). Two things broke them: ss-fixes' global Alt+C hotkey
  // ("Copy current tab URI", bound on window in the capture phase with
  // stopPropagation) swallowed the prompt's own Alt+C, and navigator.clipboard
  // is undefined on this insecure origin, so the copy threw. The fallback path
  // is document.execCommand("copy") on a temporary textarea - intercept it to
  // read back what was copied (the headless clipboard isn't readable here).
  await page.evaluate(() => {
    window.__copied = [];
    const orig = document.execCommand.bind(document);
    document.execCommand = function (cmd, ...rest) {
      if (cmd === "copy") window.__copied.push(document.activeElement?.value ?? null);
      return orig(cmd, ...rest);
    };
  });
  const copyRow = await page.evaluate(() => {
    const { popup } = window._browseSsLastPrompt;
    const d = popup.getData(popup.getRow());
    return d && { uri: d.uri, name: d.prefix ? d.value.replace(d.prefix, "") : d.value };
  });
  await selectRowThen("Alt+c");
  await page.waitForTimeout(300);
  await selectRowThen("Alt+Shift+c");
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => window.__copied);
  check("Alt+C copies the selected browse entry's name", copied[0] === copyRow?.name, { copied, copyRow });
  check("Alt+Shift+C copies its full path", copied[1] === copyRow?.uri, { copied, copyRow });
  check(
    "the browse prompt survives a copy with focus intact",
    await page.evaluate(
      () => !!document.querySelector(".ace_browse_ss_container")?.contains(document.activeElement)
    )
  );
  check("copying shows the same notification as the Copy Path actions", await page.evaluate(() =>
    [...document.querySelectorAll("div")].some((d) => d.textContent?.startsWith("Copied to clipboard:"))
  ));

  // Rebinding a browse key (options page -> chrome.storage.local.browseKeys)
  // reaches an open tab and applies to the next prompt, no reload. "" is an
  // explicit unbind, and the prompt's hint line is generated from the same table.
  await sw.evaluate(() => chrome.storage.local.set({ browseKeys: { copyPath: "Ctrl-Alt-Q", copyName: "" } }));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ssf.run("browseFiles"));
  await page
    .waitForFunction(() => window._browseSsLastPrompt?.popup?.data?.length > 0, null, { timeout: 10000 })
    .catch(() => {});
  await page.evaluate(() => (window.__copied.length = 0));
  await selectRowThen("Alt+c");
  await page.waitForTimeout(300);
  check("a cleared browse binding stops firing", (await page.evaluate(() => window.__copied)).length === 0);
  await page.keyboard.press("Control+Alt+q");
  await page.waitForTimeout(300);
  const remapped = await page.evaluate(() => window.__copied);
  check("a remapped browse binding fires on the new key", remapped.length === 1, { remapped });
  const hintText = await page.evaluate(() => document.querySelector(".ace_browse_ss_hint")?.textContent || "");
  check(
    "the prompt hint is generated from the live bindings",
    hintText.includes("Ctrl+Alt+Q copy path") && !hintText.includes("copy name"),
    { hintText }
  );
  await sw.evaluate(() => chrome.storage.local.remove("browseKeys"));
  await page.waitForTimeout(300);

  // Exact match ranks first: type the full path of an entry that isn't already
  // at the top of the directory listing and check it becomes row 0.
  const exactMatch = await page.evaluate(async () => {
    const { popup, cmdLine } = window._browseSsLastPrompt;
    const dir = cmdLine.getValue();
    const names = popup.data
      .map((d) => (d.uri || "").split("/").filter(Boolean).at(-1))
      .filter(Boolean);
    // Pick a late entry so the original order can't accidentally satisfy the check.
    const target = names.at(-1);
    if (!target || names.length < 2) return { skipped: true };
    cmdLine.setValue(dir.replace(/\/*$/, "/") + target, 1);
    await new Promise((r) => setTimeout(r, 400));
    const first = window._browseSsLastPrompt.popup.data[0];
    return { target, first: first && (first.uri || first.value) };
  });
  check(
    "browse_ss ranks an exact name match first",
    exactMatch.skipped || (exactMatch.first || "").endsWith(exactMatch.target),
    exactMatch
  );

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);

  // Reopening resumes at the path the prompt was closed on, and the empty
  // prompt lists the focused tab's own file first (when a FILE tab is focused).
  const closedAt = await page.evaluate(() => window._browseSsLastPrompt.cmdLine.getValue());
  await page.evaluate(() => window.__ssf.run("browseFiles"));
  await page.waitForTimeout(600);
  const reopened = await page.evaluate(async () => {
    const { cmdLine } = window._browseSsLastPrompt;
    const value = cmdLine.getValue();
    const tab = window.appDMS.tabs.getFocusedTab();
    cmdLine.setValue("", 1);
    await new Promise((r) => setTimeout(r, 500));
    return {
      value,
      currentTabFile: tab?.type === "FILE" ? tab.uri : null,
      firstEntry: window._browseSsLastPrompt.popup.data[0],
      lastEntry: window._browseSsLastPrompt.popup.data.at(-1),
    };
  });
  check("browse_ss reopens at the last navigated path", reopened.value === closedAt, { closedAt, ...reopened });
  check(
    "browse_ss lists the current tab first in the empty prompt",
    !reopened.currentTabFile ||
      (reopened.firstEntry?.message === "Current tab" && reopened.firstEntry?.uri === reopened.currentTabFile),
    reopened
  );
  check(
    "browse_ss lists the root path last in the empty prompt",
    reopened.lastEntry?.message === "Root",
    reopened.lastEntry
  );

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await page.waitForTimeout(300);

  // Browse roots (popup -> chrome.storage.local.browsePaths, keyed by host) reach
  // an open tab without a reload, and supersede the remembered last path.
  const TEST_ROOT = "/ssext-smoke-root/"; // needn't exist - only the start path matters
  await sw.evaluate(
    ([host, root]) => chrome.storage.local.set({ browsePaths: { [host]: { files: root } } }),
    [new global.URL(URL).host, TEST_ROOT]
  );
  await page.waitForTimeout(500);
  const seededRoot = await page.evaluate(() => window.__ssExt && window.__ssExt.browsePaths);
  check("browse roots live-apply to an open tab", seededRoot?.files === TEST_ROOT, seededRoot);

  await page.evaluate(() => window.__ssf.run("browseFiles"));
  await page.waitForTimeout(800);
  const rootedOpen = await page.evaluate(() => window._browseSsLastPrompt.cmdLine.getValue());
  check("browse_ss opens at the new root, not the remembered path", rootedOpen === TEST_ROOT, { rootedOpen });
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })));
  await sw.evaluate(() => chrome.storage.local.remove("browsePaths"));
  await page.waitForTimeout(300);

  // Per-extension Enter action + the download key. Both are checked at the
  // dispatch point (appDMS.handleWebOneEvent, stubbed) rather than by really
  // opening/downloading anything, and against a synthetic popup row, so no file
  // of a given extension has to exist on the server.
  await sw.evaluate(() =>
    chrome.storage.local.set({ browseFileActions: { lua: "text", sas: "open" } })
  );
  await page.waitForTimeout(400);
  const seededActions = await page.evaluate(() => window.__ssExt && window.__ssExt.browseFileActions);
  check(
    "per-extension browse actions live-apply to an open tab",
    seededActions?.lua === "text" && seededActions?.sas === "open" && !seededActions?.csv,
    seededActions
  );

  // One prompt per row: accept() closes it either way. handleWebOneEvent is
  // stubbed only for the keypress and put straight back - later blocks (the
  // run-in-progress open guard) wrap the real one.
  const openWithRow = async (name, key) => {
    // _browseSsLastPrompt survives the prompt that set it, so clear it first -
    // otherwise this races the new prompt and drives the closed one.
    await page.evaluate(() => {
      window._browseSsLastPrompt = null;
      window.__ssf.run("browseFiles");
    });
    await page.waitForFunction(() => window._browseSsLastPrompt?.popup, null, { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.evaluate((itemName) => {
      window.__opened = [];
      window.__origWebOneEvent = window.appDMS.handleWebOneEvent;
      window.appDMS.handleWebOneEvent = (action, item) =>
        window.__opened.push({ action, name: item && item.name });
      const { popup } = window._browseSsLastPrompt;
      popup.setData([{ value: itemName, uri: "/ssext-smoke/" + itemName, meta: "1 KB┊now" }], "");
      popup.setRow(0);
    }, name);
    await page.keyboard.press(key);
    // The reveal path walks the real project tree; it only has to not open.
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      window.appDMS.handleWebOneEvent = window.__origWebOneEvent;
      return {
        opened: window.__opened,
        closed: !document.querySelector(".ace_browse_ss_container"),
      };
    });
  };

  const luaEnter = await openWithRow("smoke.lua", "Enter");
  check(
    'Enter on a ".lua" row opens it as text, per the configured action',
    luaEnter.opened.length === 1 && luaEnter.opened[0].action === "FileOpenWithTextViewer",
    luaEnter
  );
  const sasEnter = await openWithRow("smoke.sas", "Enter");
  check(
    'Enter on an "open"-configured extension lets SAS Studio decide',
    sasEnter.opened.length === 1 && sasEnter.opened[0].action === "FileOpen",
    sasEnter
  );
  // Unlisted: revealed, even though SAS Studio can type ".csv" and would have
  // opened its import tool - the fallback is a blanket reveal, not a
  // would-this-download test.
  const csvEnter = await openWithRow("smoke.csv", "Enter");
  check(
    "Enter on an unlisted extension reveals it in the tree",
    csvEnter.opened.length === 0 && csvEnter.closed,
    csvEnter
  );
  const ctrlShiftEnter = await openWithRow("smoke.csv", "Control+Shift+Enter");
  check(
    "Ctrl+Shift+Enter lets SAS Studio decide for an unlisted file",
    ctrlShiftEnter.opened.length === 1 && ctrlShiftEnter.opened[0].action === "FileOpen",
    ctrlShiftEnter
  );
  // The case the fallback exists for: SAS Studio can't type ".zip" at all, so
  // its own handling would be the hidden-iframe download.
  const zipEnter = await openWithRow("smoke.zip", "Enter");
  check(
    'Enter on an untypeable extension (".zip") reveals it rather than downloading it',
    zipEnter.opened.length === 0 && zipEnter.closed,
    zipEnter
  );
  const altEnter = await openWithRow("smoke.sas", "Alt+Enter");
  check(
    "Alt+Enter downloads the file whatever its extension",
    altEnter.opened.length === 1 && altEnter.opened[0].action === "FileOpenWithExternalProgram",
    altEnter
  );
  await sw.evaluate(() => chrome.storage.local.remove("browseFileActions"));
  await page.waitForTimeout(300);

  // The other half of that guard: with no prompt open, the global Alt+C hotkey
  // (copy current tab URI) must still fire - and copy through the same
  // execCommand fallback, since this origin has no navigator.clipboard.
  await page.evaluate(() => (window.__copied.length = 0));
  await page.keyboard.press("Alt+c");
  await page.waitForTimeout(500);
  const globalCopy = await page.evaluate(() => ({
    copied: window.__copied,
    notified: [...document.querySelectorAll("div")].some((d) => d.textContent?.startsWith("Copied to clipboard:")),
  }));
  check(
    "global Alt+C still copies the current tab URI with no prompt open",
    globalCopy.copied.length === 1 && globalCopy.notified,
    globalCopy
  );

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

  // -- noTreeFocusSteal: editor keeps focus across the post-save tree reload ----
  // Reuses an already-open, real (non-virgin) Ace code tab; a virgin "Program N"
  // tab would route saveFile() through the Save As dialog and isn't a valid
  // subject. Saving posts the unchanged text back (a no-op write), so it's safe
  // to repeat. Asserts the OUTCOME (focus not stolen to the tree, cursor not
  // jumped to line 1) regardless of the patch internals.
  const saveFocus = await page.evaluate(async () => {
    const tabObj = window.appDMS.tabs
      .getAllTabObjects()
      .find(
        (t) => t.editor && t.editor.editor && t.editor.editor.aceEditor && t.uri && !t.editor.isVirgin(),
      );
    if (!tabObj) return { skipped: true };
    window.appDMS.tabs.selectTab(tabObj);
    const adapter = tabObj.editor.editor;
    adapter.focus();
    await new Promise((r) => setTimeout(r, 150));
    // Park the cursor away from line 1 so a setInitialFocus-style jump (the old,
    // commented-out SAS Studio approach that also reset the cursor) would show
    // up as a distinct regression from "focus came back".
    const len = adapter.aceEditor.session.getLength() || 1;
    adapter.aceEditor.gotoLine(Math.min(5, len));
    await new Promise((r) => setTimeout(r, 50));
    const cursorBefore = adapter.aceEditor.getCursorPosition();
    const focusedBefore = adapter.aceEditor.isFocused();
    // Save the unchanged file; wait out the tree reload + the patch's deferred
    // refocus (onRefresh's promise resolves ~1s after the call, refocus then).
    tabObj.editor.saveFile();
    await new Promise((r) => setTimeout(r, 3000));
    const cursorAfter = adapter.aceEditor.getCursorPosition();
    return {
      skipped: false,
      focusedBefore,
      focusedAfter: adapter.aceEditor.isFocused(),
      cursorUnchanged: cursorBefore.row === cursorAfter.row && cursorBefore.column === cursorAfter.column,
      activeInTree: !!(
        window.appDMS.projects &&
        window.appDMS.projects.tree &&
        window.appDMS.projects.tree.domNode &&
        window.appDMS.projects.tree.domNode.contains(document.activeElement)
      ),
    };
  });
  if (saveFocus.skipped) {
    check("noTreeFocusSteal (skipped: no non-virgin Ace code tab open)", false, saveFocus);
  } else {
    check("editor stays focused after save (focus not stolen by the tree reload)", saveFocus.focusedAfter, saveFocus);
    check("focus return doesn't jump the cursor to line 1", saveFocus.cursorUnchanged, saveFocus);
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

  // (f) The "Show vim key mappings" action (an SSF_TOOLS entry, so it's a command
  // palette row and a bindable hotkey) opens a prompt listing every mapping -
  // vim.js's built-ins plus the user's (the vimrc's "imap jj <Esc>" from just
  // above, which sorts first because Vim.map unshifts).
  const mapListing = await page.evaluate(async () => {
    window.__ssf.run("showVimMappings");
    for (let i = 0; i < 40 && !document.querySelector(".ace_prompt_container"); i++)
      await new Promise((r) => setTimeout(r, 50));
    const prompt = document.querySelector(".ace_prompt_container");
    const rows = [...document.querySelectorAll(".ace_autocomplete .ace_line")].map((n) => n.textContent);
    const focused = !!(prompt && prompt.contains(document.activeElement));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    return {
      opened: !!prompt,
      focused,
      rows,
      inPalette: (window.SSF_TOOLS || []).some((t) => t.name === "showVimMappings" && t.kind === "action"),
      keymapLength: window.__ssAce.require("ace/keyboard/vim").handler.defaultKeymap.length,
    };
  });
  check("showVimMappings opens the mapping list", mapListing.opened, {
    opened: mapListing.opened,
    rowCount: mapListing.rows.length,
  });
  check("the mapping list takes the focus", mapListing.focused, mapListing);
  check("showVimMappings is a command palette action", mapListing.inPalette, mapListing);
  check(
    "the mapping list has the user's mapping first, and the built-ins too",
    /jj\s+<Esc>/.test(mapListing.rows[0] || "") && mapListing.keymapLength > 100,
    { first: mapListing.rows[0], keymapLength: mapListing.keymapLength },
  );

  // Clean up storage state so reruns are deterministic.
  await sw.evaluate(() => chrome.storage.local.remove("aceConfig"));

  const deactivated = await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  check("Ace editor replacement deactivates cleanly", deactivated && deactivated.active === false, deactivated);
  // Deactivating restores SAS's stock editors; neither library moves.
  const globalAfterOff = await page.evaluate(() => ({
    separateLibs: window.ace !== window.__ssAce && window.__ssAce === window.__ssExt.newLib.ace,
    sasAceVersion: window.ace.version,
    sasStillHasOwnModules: !!window.ace.require("ace/edit_session").EditSession,
  }));
  check(
    "window.ace is still SAS's own build after deactivation",
    globalAfterOff.separateLibs && globalAfterOff.sasStillHasOwnModules,
    globalAfterOff,
  );

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

  // -- Auto-minimized run-progress dialog + single-run guard ----------------------
  const busyDialogState = await page.evaluate(async () => {
    // Pick a pre-existing code tab whose Run button is enabled - auto-minimize
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

    // Focus the run tab so the run-start "running tab" marker (ssf-running,
    // applied to the focused code tab) lands deterministically on it.
    if (runTab) {
      window.appDMS.tabs.selectTab(runTab);
      await new Promise((r) => setTimeout(r, 50));
    }

    // A run dialog (cancel callback present) is auto-minimized on creation -
    // no floating box: the dialog is display:none'd, the bottom status bar is
    // tinted amber with a Cancel link, and the running tab gets a spinner +
    // amber background (the old design pinned a small box bottom-right; that
    // was replaced by the status-bar treatment).
    const dialog = window.appDMS.dialogs.postBusyDialog("Submitting SAS Code", () => {});
    await new Promise((r) => setTimeout(r, 100));

    const runButtonDisabledAfterMinimize = runTab ? runTab.editor.submitButton.get("disabled") === true : null;
    const bgButtonStillEnabledAfterMinimize = bgTab ? bgTab.editor.backgroundSubmitButton.get("disabled") === false : null;

    const underlayHiddenAfter = !dijit._underlay || dijit._underlay.open === false;
    const dialogStillInDom = !!document.getElementById(dialog.id);
    const statusBar = document.getElementById("studio_status_bar");
    // Run start: dialog hidden, status bar tinted amber (#ffe9a8 =
    // rgb(255, 233, 168)) with a Cancel link, running tab marked.
    const dialogHidden = dialog.domNode.style.display === "none";
    // The tint is a class (ssf-run-bar) + a stylesheet inside @layer ssext-dark,
    // never an inline style - so read what is actually painted.
    const statusBarTinted =
      !!statusBar && /255,\s*233,\s*168/.test(getComputedStyle(statusBar).backgroundColor);
    const cancelLinkShown = !!document.getElementById("ssf-run-cancel");
    const runTabMarked = runTab
      ? runTab.tab.controlButton.domNode.classList.contains("ssf-running")
      : null;

    // Single-run guard: a submitHandler on any open code tab must now refuse
    // to run (appDMS.dialogs.busyDialog is still set - the dialog is only
    // minimized, not destroyed) - verified via the ss-ext busy notice the
    // guard shows (a top-left in-page element; SAS Studio's own toaster
    // truncates longer messages) instead of calling through to the real
    // submit flow (which would try to hit the network).
    const tabObj = window.appDMS.tabs.getAllTabObjects().find((t) => t.editor && t.editor.submitHandler);
    let guardRefused = null;
    let guardNoticeIsWarnStyled = null;
    if (tabObj) {
      tabObj.editor.submitHandler();
      const notice = document.getElementById("ssf-busy-notice");
      guardRefused = !!notice && /already running/i.test(notice.textContent);
      guardNoticeIsWarnStyled = !!notice && /255, 213, 79|#ffd54f/i.test(notice.style.background);
    }

    // Text-view block: opening a file as text while a run is active would fire
    // SYNCHRONOUS xhrs against the busy session (freezing the whole JS thread
    // until run end) and post SAS Studio's uncancelable "Reading file" modal -
    // the patch refuses it with a warn notice at the chain's entry point,
    // handleWebOneEvent (what the tree context menu, tree double-click, and
    // browse_ss all call), plus a perspectiveFileOpen backstop.
    const probeItem = { name: "__ssext_smoke_probe.txt", uri: "/tmp/__ssext_smoke_probe.txt", type: "FILE" };
    let textViewBlocked = null;
    let textViewEntryBlocked = null;
    try {
      const ret = window.appDMS.handleWebOneEvent("FileOpenWithTextViewer", probeItem);
      const notice = document.getElementById("ssf-busy-notice");
      // If the block failed, the busy dialog would have been replaced by a
      // "Reading file" dialog (postBusyDialog destroys the previous one).
      textViewEntryBlocked =
        ret === undefined &&
        !!notice &&
        /blocked/i.test(notice.textContent) &&
        window.appDMS.dialogs.busyDialog === dialog;
    } catch (e) {
      textViewEntryBlocked = false;
    }
    try {
      const ret = window.appDMS.perspectiveFileOpen(probeItem, null);
      const notice = document.getElementById("ssf-busy-notice");
      textViewBlocked = ret === undefined && !!notice && /blocked/i.test(notice.textContent);
    } catch (e) {
      textViewBlocked = false; // a throw means it wasn't intercepted (null target)
    }

    // Queued-request note: session-bound (/workspace/) requests fired while the
    // busy dialog exists are queued server-side; the patch shows the busy
    // notice so a stalled file open reads as "waiting", not "broken". The
    // probe URL 404s harmlessly - the notice fires on request start, not on
    // the response. It replaces the guard notice above in the same element.
    dojo.xhrGet({
      url:
        window.appDMS.baseURL +
        "/sasexec/sessions/" +
        window.appDMS.sessionId +
        "/workspace/__ssext_smoke_probe.txt",
      handleAs: "text",
      error: () => {},
    });
    const queuedEl = document.getElementById("ssf-busy-notice");
    const queuedNoteSent = !!queuedEl && /queued/i.test(queuedEl.textContent);

    // Destroy the (minimized) busy dialog, same as hideBusyDialog() at run end,
    // and confirm a later modal dialog still gets a working underlay - the
    // early DialogLevelManager.hide() call at minimize time must not have left
    // the shared stack/underlay singleton in a broken state.
    dialog.destroy();
    window.appDMS.dialogs.busyDialog = null;
    await new Promise((r) => setTimeout(r, 100));

    const runButtonReenabledAfterDestroy = runTab ? runTab.editor.submitButton.get("disabled") === false : null;
    const noticeClearedAfterDestroy = !document.getElementById("ssf-busy-notice");
    // Run end (reenable) also un-tints the status bar, drops the Cancel link,
    // and clears the running-tab marker.
    const statusBarRestoredAfterDestroy =
      !statusBar || !/255,\s*233,\s*168/.test(getComputedStyle(statusBar).backgroundColor);
    const cancelLinkRemovedAfterDestroy = !document.getElementById("ssf-run-cancel");
    const runTabUnmarkedAfterDestroy = runTab
      ? !runTab.tab.controlButton.domNode.classList.contains("ssf-running")
      : null;

    const otherDialog = new dijit.Dialog({ title: "SS Ext smoke: post-minimize modality check" });
    otherDialog.show();
    await new Promise((r) => setTimeout(r, 200));
    const otherUnderlayShown = !!(dijit._underlay && dijit._underlay.open);
    otherDialog.destroy();
    await new Promise((r) => setTimeout(r, 100));

    // A NON-run busy dialog (no cancel callback) must keep stock modal
    // behavior - not be auto-minimized.
    const readingDialog = window.appDMS.dialogs.postBusyDialog("SS Ext smoke: reading probe");
    await new Promise((r) => setTimeout(r, 100));
    const nonRunStaysModal =
      !!(dijit._underlay && dijit._underlay.open) && readingDialog.domNode.style.width !== "220px";
    readingDialog.destroy();
    window.appDMS.dialogs.busyDialog = null;

    return {
      underlayHiddenAfter,
      dialogStillInDom,
      dialogHidden,
      statusBarTinted,
      cancelLinkShown,
      runTabMarked,
      statusBarRestoredAfterDestroy,
      cancelLinkRemovedAfterDestroy,
      runTabUnmarkedAfterDestroy,
      hasTabToTestGuard: !!tabObj,
      guardRefused,
      guardNoticeIsWarnStyled,
      hasRunTab: !!runTab,
      hasBgTab: !!bgTab,
      runButtonDisabledAfterMinimize,
      bgButtonStillEnabledAfterMinimize,
      runButtonReenabledAfterDestroy,
      otherUnderlayShown,
      nonRunStaysModal,
      queuedNoteSent,
      textViewBlocked,
      textViewEntryBlocked,
      noticeClearedAfterDestroy,
    };
  });
  {
    check("run dialog is auto-minimized: no modal underlay", busyDialogState.underlayHiddenAfter, busyDialogState);
    check("run start hides the dialog (no floating box)", busyDialogState.dialogStillInDom && busyDialogState.dialogHidden, busyDialogState);
    check("run start tints the status bar and adds a Cancel link", busyDialogState.statusBarTinted && busyDialogState.cancelLinkShown, busyDialogState);
    check(
      busyDialogState.hasRunTab
        ? "run start marks the running (focused code) tab"
        : "run start marks the running tab (skipped: no code tab focused)",
      !busyDialogState.hasRunTab || busyDialogState.runTabMarked === true,
      busyDialogState,
    );
    check(
      busyDialogState.hasTabToTestGuard
        ? "single-run guard blocks submitHandler while busyDialog is set"
        : "single-run guard blocks submitHandler while busyDialog is set (skipped: no code tab open)",
      !busyDialogState.hasTabToTestGuard || busyDialogState.guardRefused === true,
      busyDialogState,
    );
    check(
      busyDialogState.hasTabToTestGuard
        ? "single-run guard notice is warn-styled (yellow)"
        : "single-run guard notice is warn-styled (yellow) (skipped: no code tab open)",
      !busyDialogState.hasTabToTestGuard || busyDialogState.guardNoticeIsWarnStyled === true,
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
    check("non-run busy dialogs (no cancel callback) keep stock modal behavior", busyDialogState.nonRunStaysModal, busyDialogState);
    check("session-bound (/workspace/) requests fired while busy get a queued-request note", busyDialogState.queuedNoteSent, busyDialogState);
    check("handleWebOneEvent(FileOpenWithTextViewer) while a run is active is refused with a notice", busyDialogState.textViewEntryBlocked, busyDialogState);
    check("perspectiveFileOpen backstop refuses a text-view (TXT) open while a run is active", busyDialogState.textViewBlocked, busyDialogState);
    check("busy notice is cleared when the busy dialog is destroyed", busyDialogState.noticeClearedAfterDestroy, busyDialogState);
    check(
      "run end un-tints the status bar and removes the Cancel link",
      busyDialogState.statusBarRestoredAfterDestroy && busyDialogState.cancelLinkRemovedAfterDestroy,
      busyDialogState,
    );
    check(
      busyDialogState.hasRunTab
        ? "run end clears the running-tab marker"
        : "run end clears the running-tab marker (skipped: no code tab focused)",
      !busyDialogState.hasRunTab || busyDialogState.runTabUnmarkedAfterDestroy === true,
      busyDialogState,
    );
  }

  // -- Save As under a new extension -----------------------------------------------
  // Save As ends in successfulOnFileSave, NOT successfulSave, so nothing used to
  // re-derive the mode (a program saved as .lua kept SAS highlighting) or clear
  // the unsaved-change gutter. Placed BEFORE the dark-mode block, which reloads
  // the page: after a reload Ace is off and no tab is focused, and a Save As
  // driven from an unfocused tab silently does nothing - saveFocusedFileAtPath
  // bails to a notification and returns undefined, so awaiting it looks like
  // success. It opens and closes its own tab, so it disturbs no other block.
  const saveAs = await page.evaluate(async (lp) => {
    const a = window.appDMS;
    if (!window.__ssExt.active) {
      await window.__ssExt.toggle(lp);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const root = "/folders/myfolders";
    const url =
      a.baseURL + "/sasexec/sessions/" + a.sessionId + "/workspace/" + encodeValue(root) + "?includeChildren=true";
    const children = await new Promise((res) => {
      dojo.xhrGet({
        url,
        handleAs: "json",
        preventCache: true,
        load: (d) => res((d && d[0] && d[0].children) || []),
        error: () => res([]),
      });
    });
    const openUris = new Set(a.tabs.getAllTabObjects().map((t) => t.uri));
    const f = children.find(
      (c) => c.size && Number(c.size) > 0 && /\.sas$/i.test(c.name) && !openUris.has(root + "/" + c.name),
    );
    if (!f) return { skipped: "no unopened .sas file to save as" };
    const uri = root + "/" + f.name;
    a.handleWebOneEvent("FileOpen", { uri, name: f.name, id: uri.replaceAll("/", "~ps~"), type: "FILE" });
    let t = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      t = a.tabs.getAllTabObjects().find((x) => x.uri === uri && x.editor && x.editor.editor);
      if (t && t.editor.editor.aceEditor) break;
    }
    if (!t || !t.editor.editor.aceEditor) return { skipped: "opened tab never got an Ace editor" };
    const adapter = t.editor.editor;
    // saveFocusedFileAtPath works off appDMS.tabs.getFocusedTab().editor, which is
    // not the same thing as the Ace editor holding DOM focus.
    let tabFocused = false;
    for (let i = 0; i < 20; i++) {
      a.tabs.selectTab(t);
      adapter.aceEditor.focus();
      await new Promise((r) => setTimeout(r, 250));
      const ft = a.tabs.getFocusedTab();
      tabFocused = !!(ft && ft.editor === t.editor && typeof ft.editor.saveFileAs === "function");
      if (tabFocused && adapter.aceEditor.isFocused()) break;
    }
    adapter.aceEditor.insert("\n* ssext save-as probe;\n");
    await new Promise((r) => setTimeout(r, 600));
    const before = {
      mode: adapter.aceEditor.session.$modeId,
      dirty: (adapter._dirtyRows || []).length,
      name: t.editor.name,
    };
    // Unique name: a second run would otherwise hit the overwrite prompt and the
    // save would silently not happen. Deleted again below.
    const path = root + "/ssext_saveas_" + Date.now() + ".lua";
    await window.__ssf.saveFocusedFileAtPath(path);
    for (let i = 0; i < 40; i++) {
      if (t.editor.name !== before.name) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const out = {
      before,
      tabFocused,
      name: t.editor.name,
      mode: adapter.aceEditor.session.$modeId,
      dirty: (adapter._dirtyRows || []).length,
    };
    const delUrl = a.baseURL + "/sasexec/sessions/" + a.sessionId + "/workspace/" + encodeValue(path);
    out.deleted = await new Promise((res) =>
      dojo.xhrDelete({ url: delUrl, preventCache: true, load: () => res(true), error: () => res(false) }),
    );
    // Leave nothing behind. A failed save leaves the tab DIRTY, and closing a dirty
    // tab raises the save-confirmation modal, which would then hold focus through
    // every later block - so answer it if it appears.
    // tabs.closeTab, NOT tab.onClose: onClose is the X-button path and it left the
    // tab open here (measured - no error thrown, the tab still in getAllTabObjects
    // 5s later), while closeTab is the programmatic one the rest of this file uses.
    try {
      a.tabs.closeTab(t);
      await new Promise((r) => setTimeout(r, 500));
      const dlg = Object.values(dijit.registry._hash || {}).find(
        (w) => w.id && w.id.indexOf("tabsFileCloseConfirmation_") === 0,
      );
      if (dlg) {
        dijit.byId(dlg.id + "_dontSaveBtn").onClick();
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      out.closeError = String((e && e.message) || e);
    }
    // Identify the tab by OBJECT, not by id: successfulOnFileSave rewrites the tab
    // id from the new uri, so the id captured before the save is already stale.
    for (let i = 0; i < 20; i++) {
      out.closed = !a.tabs.getAllTabObjects().some((x) => x === t);
      if (out.closed) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  }, libPath);
  if (saveAs.skipped) {
    check("save-as test setup (skipped: " + saveAs.skipped + ")", false, saveAs);
  } else {
    check(
      "Save As to .lua switches the editor off the SAS mode",
      saveAs.before.mode === "ace/mode/sas" && saveAs.mode === "ace/mode/lua",
      saveAs,
    );
    check("Save As re-baselines the unsaved-change gutter", saveAs.before.dirty > 0 && saveAs.dirty === 0, saveAs);
    check("save-as test cleans up its own tab", saveAs.closed, saveAs);
  }

  // -- Dark mode (src/dark.css via a registered CSS content script) -----------------
  // The headline check is the regression that made a runtime dark-mode
  // extension unusable here: on reload, SAS Studio's ~95 nested-@import
  // stylesheets would sometimes come back incomplete, and losing dijit.css
  // takes out BOTH the icon background-images and .dijitDisplayNone - so icon
  // buttons rendered as bare text labels. A static sheet can't race anything,
  // and these assert exactly that symptom is absent.
  const readDark = () =>
    page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(bg);
      const icons = [...document.querySelectorAll('[class*="Icon"], [class*="icon"]')].filter(
        (el) => el.offsetParent !== null,
      );
      const withImage = icons.filter((el) => getComputedStyle(el).backgroundImage !== "none");
      // Icon-only dijit buttons hide their label via dijit.css's
      // .dijitDisplayNone - the rule that vanished along with the icons.
      const hiddenLabels = [...document.querySelectorAll(".dijitButtonText.dijitDisplayNone")];
      return {
        bodyBg: bg,
        bodyIsDark: !!m && (+m[1] + +m[2] + +m[3]) / 3 < 120,
        iconCount: icons.length,
        iconsWithImage: withImage.length,
        // Any icon image that 404s decodes to nothing - naturalWidth 0.
        brokenIconUrls: withImage
          .map((el) => /url\("?([^")]+)/.exec(getComputedStyle(el).backgroundImage)[1])
          .filter((u, i, a) => a.indexOf(u) === i)
          .slice(0, 40),
        labelCount: hiddenLabels.length,
        labelsStillHidden: hiddenLabels.every((el) => getComputedStyle(el).display === "none"),
      };
    });

  const checkIconUrls = async (urls) =>
    page.evaluate(
      (list) =>
        Promise.all(
          list.map(
            (u) =>
              new Promise((res) => {
                const i = new Image();
                i.onload = () => res(i.naturalWidth > 0 ? null : u);
                i.onerror = () => res(u);
                i.src = u;
              }),
          ),
        ).then((r) => r.filter(Boolean)),
      urls,
    );

  const setDarkMode = async (mode) => {
    await sw.evaluate((m) => chrome.storage.local.set({ darkMode: m }), mode);
    await page.waitForTimeout(1500);
  };

  const beforeDark = await readDark();
  await setDarkMode("on");

  // Live apply (no reload): the storage listener insertCSS()es into open tabs.
  const liveDark = await readDark();
  check(
    "dark mode applies to an already-open tab without a reload",
    !beforeDark.bodyIsDark && liveDark.bodyIsDark,
    { beforeDark: beforeDark.bodyBg, liveDark: liveDark.bodyBg },
  );

  // Now the real thing: a fresh page load with the CSS registered at
  // document_start.
  await releaseSession(page);
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await waitForPatches();

  const afterReload = await readDark();
  check("dark mode survives a page reload", afterReload.bodyIsDark, afterReload);
  check(
    "icons still render with dark mode on after a reload",
    afterReload.iconCount > 0 && afterReload.iconsWithImage > 0,
    afterReload,
  );
  const broken = await checkIconUrls(afterReload.brokenIconUrls);
  check("no icon image 404s with dark mode on (the relative-url trap)", broken.length === 0, broken);
  check(
    afterReload.labelCount > 0
      ? "icon-button labels stay hidden with dark mode on (dijit.css intact)"
      : "icon-button labels stay hidden (skipped: no icon-only buttons on screen)",
    afterReload.labelCount === 0 || afterReload.labelsStillHidden,
    afterReload,
  );

  // darkMode "on" must drag Ace onto its dark theme even though the OS here is
  // light, or you get dark chrome around a light editor.
  await page.addScriptTag({ path: require("path").join(EXT, "src", "editor-swap.js") });
  await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  await page.waitForTimeout(1500);
  const aceTheme = await page.evaluate(() => {
    const tabObj = window.appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor);
    return {
      osIsDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      darkMode: window.__ssExt.darkMode,
      theme: tabObj ? tabObj.editor.editor.aceEditor.getTheme() : null,
      configured: (window.__ssExt.aceConfig || {}).darkTheme,
    };
  });
  check(
    "darkMode 'on' puts Ace on its dark theme regardless of the OS setting",
    !aceTheme.osIsDark && aceTheme.theme && aceTheme.theme === aceTheme.configured,
    aceTheme,
  );

  // ...and the overlays ace builds for us (prompt container styled `background:
  // white` by ace, inner editors created with no theme at all) have to come
  // along, or dark mode means a white box of light-on-light text.
  const overlayDark = await page.evaluate(async () => {
    window.__ssExt.commandPalette();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector(".ace_prompt_container")) break;
    }
    const el = document.querySelector(".ace_prompt_container");
    const inner = el && el.querySelector(".ace_editor");
    const list = el && el.querySelector(".ace_autocomplete");
    const rgb = el && getComputedStyle(el).backgroundColor.match(/\d+/g);
    const width = (n) => (n ? Math.round(n.getBoundingClientRect().width) : 0);
    const state = {
      // The editor's own popup is widened to 400px for the meta column; the
      // prompt's list sizes to the prompt box and must not inherit that.
      inputWidth: width(inner),
      listWidth: width(list),
      // ace's default is 12px; the prompt should read at the editor's size.
      fontSize: inner && getComputedStyle(inner).fontSize,
      listFontSize: list && getComputedStyle(list).fontSize,
      configuredFontSize: ((window.__ssExt.aceConfig || {}).options || {}).fontSize,
      bodyMarked: document.body.classList.contains("ssExtDark"),
      background: el && getComputedStyle(el).backgroundColor,
      // A dark container: every channel well below mid-grey.
      isDark: !!rgb && rgb.slice(0, 3).every((c) => Number(c) < 96),
      innerIsDark: !!(inner && inner.classList.contains("ace_dark")),
      innerTheme: inner && inner.className,
    };
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 27, bubbles: true }));
    return state;
  });
  check(
    "the palette/browse/settings overlays follow dark mode",
    overlayDark.bodyMarked && overlayDark.isDark && overlayDark.innerIsDark,
    overlayDark,
  );
  check(
    "the prompt's completion list keeps the width of its input box",
    Math.abs(overlayDark.listWidth - overlayDark.inputWidth) <= 4,
    overlayDark,
  );
  check(
    "the prompt uses the configured editor font size, not ace's 12px default",
    overlayDark.fontSize === `${overlayDark.configuredFontSize}px` &&
      overlayDark.listFontSize === `${overlayDark.configuredFontSize}px`,
    overlayDark,
  );

  // The stylesheet is a <link> node we own (src/dark-inject.js), not
  // extension-injected CSS - that is the whole reason removal can be live. If
  // this ever goes back to `css: [...]` in registerContentScripts, the sheet
  // becomes unreachable (not in document.styleSheets, and removeCSS only knows
  // about insertCSS'd sheets) and turning dark mode off silently needs a
  // reload again.
  const linkState = await page.evaluate(() => {
    const link = document.getElementById("ssext-dark-css");
    return {
      present: !!link,
      isLink: !!link && link.tagName === "LINK" && link.rel === "stylesheet",
      extensionUrl: !!link && link.href.startsWith("chrome-extension://"),
      media: link ? link.media : null,
    };
  });
  check(
    "dark stylesheet is a page-owned <link> node (so it can be removed live)",
    linkState.present && linkState.isLink && linkState.extensionUrl,
    linkState,
  );

  // Off again - live this time, in both directions, and Ace with it.
  await setDarkMode("off");
  const liveOff = await page.evaluate(() => {
    const tabObj = window.appDMS.tabs
      .getAllTabObjects()
      .find((t) => t.editor && t.editor.editor && t.editor.editor.aceEditor);
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      linkGone: !document.getElementById("ssext-dark-css"),
      aceTheme: tabObj ? tabObj.editor.editor.aceEditor.getTheme() : null,
      lightTheme: (window.__ssExt.aceConfig || {}).lightTheme,
      osIsDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    };
  });
  check(
    "turning dark mode off restores the light UI without a reload",
    liveOff.linkGone && !/36, 37, 37/.test(liveOff.bodyBg),
    liveOff,
  );
  check(
    "Ace follows dark mode back off in the same pass (no light-editor-in-dark-chrome)",
    !liveOff.osIsDark && (!liveOff.aceTheme || liveOff.aceTheme === liveOff.lightTheme),
    liveOff,
  );

  // "Follow system" is the link's media attribute, not a second stylesheet.
  await setDarkMode("system");
  const systemState = await page.evaluate(() => {
    const link = document.getElementById("ssext-dark-css");
    return {
      present: !!link,
      media: link ? link.media : null,
      // OS is light in headless, so the media query must NOT match.
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  check(
    "follow-system attaches one stylesheet gated by a media attribute",
    systemState.present &&
      systemState.media === "(prefers-color-scheme: dark)" &&
      !/36, 37, 37/.test(systemState.bodyBg),
    systemState,
  );
  await setDarkMode("off");

  await releaseSession(page);
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await waitForPatches();
  const offAfterReload = await page.evaluate(() => ({
    bodyBg: getComputedStyle(document.body).backgroundColor,
    linkGone: !document.getElementById("ssext-dark-css"),
  }));
  check(
    "dark mode stays off after a reload (content script unregistered)",
    offAfterReload.linkGone && !/36, 37, 37/.test(offAfterReload.bodyBg),
    offAfterReload,
  );

  // -- Keyboard entry points into SAS Studio's own widgets --------------------------
  // These are pure widget lookups, so what they guard against is SAS Studio's own
  // internals drifting - only a live check sees that. Runs last: the tab-group part
  // creates a real split, then puts the tab back.
  const paneFocus = await page.evaluate(() => {
    window.__ssf.run("focusCodeEditor");
    window.__ssf.run("focusPaneBar");
    return {
      active: document.activeElement.id,
      selected: window.appDMS.tabs.getFocusedTab().editor.sasSuiteTabContainer.selectedChildWidget.type,
    };
  });
  check("focusPaneBar focuses the selected pane's tab button", /tablist/.test(paneFocus.active), paneFocus);
  // dijit's _KeyNavContainer takes over from there - that's the whole point.
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const paneAfter = await page.evaluate(
    () => window.appDMS.tabs.getFocusedTab().editor.sasSuiteTabContainer.selectedChildWidget.type,
  );
  check("arrow keys then move between panes", paneFocus.selected !== paneAfter, { paneFocus, paneAfter });

  const tabBarFocus = await page.evaluate(() => {
    window.__ssf.run("focusCodeEditor");
    window.__ssf.run("focusTabBar");
    return document.activeElement.id;
  });
  check("focusTabBar focuses the open-file tab strip", /mainTabs_tablist/.test(tabBarFocus), { tabBarFocus });

  // Must beat the noTreeFocusSteal patch, which suppresses tree focus coming from
  // outside the tree - dijit's focus() goes through focusChild, not focusNode.
  const treeFocus = await page.evaluate(() => {
    window.__ssf.run("focusCodeEditor");
    window.__ssf.run("focusSideBarTree");
    return { id: document.activeElement.id, cls: (document.activeElement.className || "").toString() };
  });
  check("focusSideBarTree reaches the tree from the editor", /dijitTreeLabel/.test(treeFocus.cls), treeFocus);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const treeAfter = await page.evaluate(() => document.activeElement.id);
  check("arrow keys then navigate the tree", treeAfter && treeAfter !== treeFocus.id, { treeFocus, treeAfter });

  // -- Pane groups, the run-focus-steal patch and the log editor tab ----------------
  // All three are about one code tab's own panes, so they share the tab this block
  // opens (and closes again at the end). The run is a one-liner against sashelp so
  // it comes back fast, but it IS a real submission to the shared session.
  await page.evaluate(() => window.appDMS.tabs.onNewProgram());
  await page.waitForTimeout(2500);

  const paneSplit = await page.evaluate(async () => {
    const ed = () => window.appDMS.tabs.getFocusedTab().editor;
    const wait = () => new Promise((r) => setTimeout(r, 600));
    // SAS Studio persists the pane layout, so a new tab can come up already
    // split from a previous run - start from one group either way.
    window.__ssf.run("resetLayoutCurrentTab");
    await wait();
    window.__ssf.run("switchPaneGroup");
    const noSplitWarn = document.body.innerText.includes("Panes aren't split");
    window.__ssf.run("movePaneToOtherGroup"); // the Code pane, out to the right
    await wait();
    const out = { right: !!ed().rightTabs, main: ed().sasSuiteTabContainer.getChildren().length };
    // and back again - which destroys the strip it just created
    window.__ssf.run("movePaneToOtherGroup");
    await wait();
    return { noSplitWarn, out, backRight: !!ed().rightTabs, backMain: ed().sasSuiteTabContainer.getChildren().length };
  });
  check("switchPaneGroup warns instead of throwing with no pane split", paneSplit.noSplitWarn, paneSplit);
  check("movePaneToOtherGroup splits the panes out to the right", paneSplit.out.right, paneSplit);
  check(
    "...and moving it back destroys the strip again",
    !paneSplit.backRight && paneSplit.backMain === paneSplit.out.main + 1,
    paneSplit,
  );

  const paneGroupSwitch = await page.evaluate(async () => {
    const ed = () => window.appDMS.tabs.getFocusedTab().editor;
    const wait = () => new Promise((r) => setTimeout(r, 600));
    // Move the LOG pane out so the editor pane stays in the main group.
    ed().sasSuiteTabContainer.selectChild(ed().logContentPane);
    window.__ssf.run("movePaneToOtherGroup");
    await wait();
    window.__ssf.run("focusCodeEditor");
    await wait();
    const from = ed().selectedTab.type;
    window.__ssf.run("switchPaneGroup");
    await wait();
    const to = ed().selectedTab.type;
    window.__ssf.run("switchPaneGroup");
    await wait();
    const back = ed().selectedTab.type;
    window.__ssf.run("resetLayoutCurrentTab"); // cleanup: one group again
    await wait();
    return { from, to, back, groups: [ed().rightTabs, ed().bottomTabs].filter(Boolean).length };
  });
  check(
    "switchPaneGroup cycles between the pane groups",
    paneGroupSwitch.from === "editor" && paneGroupSwitch.to === "log" && paneGroupSwitch.back === "editor",
    paneGroupSwitch,
  );
  check("resetLayoutCurrentTab puts the panes back in one group", paneGroupSwitch.groups === 0, paneGroupSwitch);

  // The main group can't be emptied - same constraint as the tab groups.
  const lastPaneRefused = await page.evaluate(async () => {
    const ed = window.appDMS.tabs.getFocusedTab().editor;
    const panes = ed.sasSuiteTabContainer.getChildren().slice(1);
    for (const p of panes) {
      ed.sasSuiteTabContainer.selectChild(p);
      window.__ssf.run("movePaneToOtherGroup");
      await new Promise((r) => setTimeout(r, 600));
    }
    ed.sasSuiteTabContainer.selectChild(ed.sasSuiteTabContainer.getChildren()[0]);
    window.__ssf.run("movePaneToOtherGroup");
    const state = { warned: document.body.innerText.includes("Last pane in the main group"), main: ed.sasSuiteTabContainer.getChildren().length };
    window.__ssf.run("resetLayoutCurrentTab");
    await new Promise((r) => setTimeout(r, 600));
    return state;
  });
  check(
    "movePaneToOtherGroup refuses to empty the main pane group",
    lastPaneRefused.warned && lastPaneRefused.main === 1,
    lastPaneRefused,
  );

  // Two real (tiny) submissions, one per runFocus mode that changes anything.
  // Default is "log": the Log pane at run START only, nothing at the end.
  const runTabTitle = await page.evaluate(() => window.appDMS.tabs.getFocusedTab().title);
  const runProgram = async (code) => {
    await page.evaluate((c) => {
      const ed = window.appDMS.tabs.getFocusedTab().editor;
      ed.logURL = null;
      ed.setEditContent(c);
      window.__ssf.run("focusCodeEditor");
      window.__ssf.run("runCurrentProgram");
    }, code);
    await page
      .waitForFunction(() => !!window.appDMS.tabs.getFocusedTab().editor.logURL, null, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(3500); // submitComplete's own 250ms focus timeout, and then some
  };
  const paneState = () =>
    page.evaluate(() => {
      const ed = window.appDMS.tabs.getFocusedTab().editor;
      const chip = (p) => !!(p && p.controlButton && p.controlButton.domNode.classList.contains("ssf-pane-updated"));
      return {
        selected: ed.selectedTab && ed.selectedTab.type,
        results: chip(ed.outputContentPane),
        data: chip(ed.dataContentPane),
        hasDataPane: !!ed.dataContentPane,
        log: chip(ed.logContentPane),
        active: (document.activeElement && document.activeElement.className) || "",
        logText: (ed.logAreaContentPane.domNode.textContent || "").slice(0, 400),
      };
    });

  await page.waitForTimeout(500);
  await runProgram("proc print data=sashelp.class(obs=1); run;");
  const afterLogMode = await paneState();
  check('runFocus "log": a run selects the Log pane at start', afterLogMode.selected === "log", afterLogMode);
  check("...but the completed run leaves it there and outlines Results instead", afterLogMode.results, afterLogMode);
  // SAS Studio's own submit preamble - present in every log it renders.
  check("the run produced a log to read", /OPTIONS NONOTES/.test(afterLogMode.logText), afterLogMode);

  // "none": nothing moves at all. Set through storage, so this also covers sw.js's
  // live apply - the patch reads __ssf.runFocus per call, so no reload is needed.
  await sw.evaluate(() => chrome.storage.local.set({ runFocus: "none" }));
  await page.waitForTimeout(500);
  const modePushed = await page.evaluate(() => window.__ssf.runFocus);
  check("a runFocus change reaches the open tab without a reload", modePushed === "none", { modePushed });
  await page.evaluate(() => window.__ssf.run("focusCodeEditor"));
  await page.waitForTimeout(400);
  // Output data AND results this time: the data pane is a brand new widget that
  // SAS never selectTab()s when there are results too, so it is only marked
  // because createDataTab is - the case the selectTab-only marking missed.
  await runProgram("data work.ssext_probe; set sashelp.class; run; proc print data=work.ssext_probe(obs=1); run;");
  const afterNoneMode = await paneState();
  check('runFocus "none": the run leaves the editor pane selected', afterNoneMode.selected === "editor", afterNoneMode);
  // submitComplete focuses the Results chip (or, on the log pane, setNextFocus's)
  // 250ms after the run ends - neither may happen here.
  check("...and the keyboard where it was, not on a pane chip", !/dijitTab/.test(afterNoneMode.active), afterNoneMode);
  check("...outlining Results and the new Output data pane", afterNoneMode.results && afterNoneMode.data, afterNoneMode);
  // The log streams throughout a run, so an outline on it would mean nothing.
  check("...and never the Log pane", !afterNoneMode.log, afterNoneMode);
  await sw.evaluate(() => chrome.storage.local.remove("runFocus"));
  await page.waitForTimeout(300);

  // Turn the Ace replacement back on (the last reload of the dark-mode block left it
  // off) - the log tab's mode is the whole point, and only the Ace path has one.
  await page.addScriptTag({ path: require("path").join(EXT, "src", "editor-swap.js") });
  await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  await page.waitForTimeout(1500);

  // Opened with the editor pane selected, i.e. with the Log pane display:none - the
  // case where a plain innerText degrades to textContent (no line breaks, and the
  // log document's <style> block dragged in as text).
  const logTab = await page.evaluate(async () => {
    window.__ssf.run("openLogInTextTab");
    await new Promise((r) => setTimeout(r, 2500));
    const tab = window.appDMS.tabs.getFocusedTab();
    const entry = window.__ssExt._textViewers.find((e) => e.tabHolder === tab.tab.tabHolder);
    const text = entry.adapter.getText() || "";
    return {
      title: tab.title,
      isViewer: !!entry,
      mode: entry.adapter.aceEditor && entry.adapter.aceEditor.session.$modeId,
      readOnly: entry.adapter.aceEditor.getReadOnly(),
      lines: text.split("\n").length,
      head: text.slice(0, 200),
    };
  });
  check(
    "openLogInTextTab opens the log in a .log text-viewer tab, line breaks and all",
    logTab.isViewer && /\.log( \d+)?$/.test(logTab.title) && /OPTIONS NONOTES/.test(logTab.head) && logTab.lines > 5,
    logTab,
  );
  check("...without the log document's stylesheet as text", !/sasError\s*\{/.test(logTab.head), logTab);
  // The tab name is what picks the mode (aceModeFor), and SAS Studio appends a
  // " <n>" counter to it - "Program 1.log 1" must still resolve to saslog.
  check("...in saslog mode", logTab.mode === "ace/mode/saslog", logTab);
  // Editable like any other text viewer - F5 puts the log back anyway.
  check("...and editable", !logTab.readOnly, logTab);

  // Refresh (F5 / the viewer's own Refresh button, both via appDMS.onTextRefresh)
  // re-reads the source tab's Log pane - here stood in for by a direct write to it,
  // which is what a second run would leave behind.
  const refreshed = await page.evaluate(async (runTab) => {
    const tabs = window.appDMS.tabs;
    const src = tabs.getAllTabObjects().find((t) => t.title === runTab);
    src.editor.logAreaContentPane.set("content", "<pre>SSEXT REFRESH MARKER</pre>");
    await new Promise((r) => setTimeout(r, 300));
    window.__ssf.run("reloadCurrentFile");
    await new Promise((r) => setTimeout(r, 500));
    const tab = tabs.getFocusedTab();
    const entry = window.__ssExt._textViewers.find((e) => e.tabHolder === tab.tab.tabHolder);
    return { text: entry.adapter.getText(), stillFocused: tab.title };
  }, runTabTitle);
  check("F5 on the log tab re-reads the log from the tab it came from", /SSEXT REFRESH MARKER/.test(refreshed.text), refreshed);

  await page.evaluate((lp) => window.__ssExt.toggle(lp), libPath);
  await page.waitForTimeout(1000);

  // Selecting a marked pane clears the mark - through the dijit container's
  // selectChild, so it holds for a tab that existed before the patch was installed,
  // for the pane-bar arrow keys and for a plain click alike.
  const marks = await page.evaluate(async (runTab) => {
    const tabs = window.appDMS.tabs;
    tabs.selectTab(tabs.getAllTabObjects().find((t) => t.title === runTab));
    await new Promise((r) => setTimeout(r, 600));
    const ed = tabs.getFocusedTab().editor;
    const marked = (p) => p.controlButton.domNode.classList.contains("ssf-pane-updated");
    const before = { results: marked(ed.outputContentPane), data: marked(ed.dataContentPane) };
    // Step to the Results pane with the hotkey action - one call at a time, since
    // selectNextPane reads editorTab.selectedTab, which dijit only updates once
    // its own transition has run.
    for (let i = 0; i < 4 && ed.selectedTab !== ed.outputContentPane; i++) {
      window.__ssf.run("selectNextPane");
      await new Promise((r) => setTimeout(r, 600));
    }
    // The pane chips have no stable dom id of their own - tag the one to click.
    ed.dataContentPane.controlButton.domNode.setAttribute("data-ssext-probe", "data-chip");
    return {
      before,
      reachedResults: ed.selectedTab === ed.outputContentPane,
      afterResults: marked(ed.outputContentPane),
    };
  }, runTabTitle);
  // ...and a plain mouse click on the chip.
  await page.click('[data-ssext-probe="data-chip"]');
  await page.waitForTimeout(400);
  const dataCleared = await page.evaluate(
    () =>
      !window.appDMS.tabs
        .getFocusedTab()
        .editor.dataContentPane.controlButton.domNode.classList.contains("ssf-pane-updated"),
  );
  check(
    "selecting a marked pane clears its mark (hotkey and chip click)",
    marks.before.results && marks.before.data && marks.reachedResults && !marks.afterResults && dataCleared,
    { marks, dataCleared },
  );

  // The pre-existing-tab case, which every tab in this session is too young to
  // be: DMSEditor's constructor dojo.connect()s the pane container's selectChild,
  // and dojo/aspect answers that with an own `selectChild` on the container whose
  // around-advice holds the PROTOTYPE FUNCTION AS CAPTURED THEN. A tab built
  // before our patch (the blank editor at startup, anything restored from the
  // last session) therefore selects panes through the pristine prototype for the
  // rest of the page's life. Calling it directly is exactly that path.
  const staleClear = await page.evaluate(async (runTab) => {
    const tabs = window.appDMS.tabs;
    const ed = tabs.getAllTabObjects().find((t) => t.title === runTab).editor;
    const chip = ed.outputContentPane.controlButton.domNode;
    const container = ed.outputContentPane.getParent();
    container.selectChild(ed.editContentPane);
    await new Promise((r) => setTimeout(r, 500));
    chip.classList.add("ssf-pane-updated");
    const pristine = window.require("dijit/layout/StackContainer").prototype.selectChild;
    pristine.call(container, ed.outputContentPane);
    await new Promise((r) => setTimeout(r, 500));
    const cleared = !chip.classList.contains("ssf-pane-updated");
    chip.classList.remove("ssf-pane-updated");
    return { cleared, ownSelectChild: Object.prototype.hasOwnProperty.call(container, "selectChild") };
  }, runTabTitle);
  check(
    "a pane selected through the pristine prototype selectChild still clears its mark",
    staleClear.cleared && staleClear.ownSelectChild,
    staleClear,
  );

  // The mark that could never be cleared: with the panes SPLIT, one pane per strip
  // is on screen, but DMSEditor.selectedTab is a single value - so a pane visible
  // in a side strip used to be outlined anyway, and clearing hangs off selectChild,
  // which you never call on a pane you can already see. Nothing is marked here.
  const splitPane = await page.evaluate(async () => {
    const ed = window.appDMS.tabs.getFocusedTab().editor;
    // Select Results through the container's OWN selectChild: the block above
    // drives the pristine prototype on purpose, which bypasses SAS's own
    // onTabSelect connection and leaves ed.selectedTab (what
    // movePaneToOtherGroup acts on) pointing at the previous pane.
    ed.sasSuiteTabContainer.selectChild(ed.outputContentPane);
    await new Promise((r) => setTimeout(r, 600));
    window.__ssf.run("movePaneToOtherGroup");
    await new Promise((r) => setTimeout(r, 1200));
    window.__ssf.run("focusCodeEditor");
    await new Promise((r) => setTimeout(r, 400));
    return {
      // A real strip of its own - "is it its own container's selected child" is
      // true in the UNSPLIT case too, so it proves nothing on its own.
      resultsInOwnStrip:
        !!ed.rightTabs &&
        ed.outputContentPane.getParent() === ed.rightTabs &&
        ed.rightTabs.selectedChildWidget === ed.outputContentPane,
      selected: ed.selectedTab && ed.selectedTab.type,
    };
  });
  await runProgram("data work.ssext_probe2; set sashelp.class; run; proc print data=work.ssext_probe2(obs=1); run;");
  const afterSplitRun = await paneState();
  check(
    "a run never outlines a pane a split layout keeps on screen (Output data still is)",
    splitPane.resultsInOwnStrip && splitPane.selected !== "output" && !afterSplitRun.results && afterSplitRun.data,
    { splitPane, afterSplitRun },
  );
  await page.evaluate(() => window.__ssf.run("resetLayoutCurrentTab"));
  await page.waitForTimeout(1500);

  // Close the two tabs this block opened (by title - the session may have had tabs
  // open before). Both hold unsaved content, so clear the dirty flag first,
  // otherwise closing pops a save prompt.
  await page.evaluate(async (runTab) => {
    const tabs = window.appDMS.tabs;
    for (const t of tabs.getAllTabObjects().filter((t) => t.title === runTab || t.title.startsWith(runTab + ".log"))) {
      if (t.editor) t.editor.editorContentChanged = false;
      tabs.closeTab(t);
      await new Promise((r) => setTimeout(r, 700));
    }
  }, runTabTitle);
  await page.waitForTimeout(500);

  // The session restores whatever tabs the user left open, so every count below
  // is relative to what is actually there plus the one tab this block adds -
  // hard-coded counts only ever passed against an otherwise-empty session.
  const baseTitles = await page.evaluate(() =>
    window.appDMS.tabs.getAllTabObjects().map((t) => t.title),
  );
  const tabCount = baseTitles.length + 1;

  const noSplitWarned = await page.evaluate(() => {
    window.__ssf.run("switchTabGroup");
    return document.body.innerText.includes("No tab group split");
  });
  check("switchTabGroup warns instead of throwing with no split", noSplitWarned, { noSplitWarned });

  // A lone tab can't be split off - the group it would leave behind would be empty.
  // The action only runs when the check applies: with other tabs open it would
  // really split, and every check below starts from an unsplit tab area.
  const lonelyRefused = await page.evaluate(() => {
    const before = window.appDMS.tabs.getAllTabObjects().length;
    if (before !== 1) return { before };
    window.__ssf.run("moveTabToOtherGroup");
    return { before, warned: document.body.innerText.includes("nothing to split it from"), split: !!window.appDMS.tabs.secondaryTabContainer };
  });
  check(
    `moveTabToOtherGroup refuses when the current tab is the only one${lonelyRefused.before === 1 ? "" : " (skipped: more than one tab open)"}`,
    lonelyRefused.before !== 1 || (lonelyRefused.warned && !lonelyRefused.split),
    lonelyRefused,
  );

  await page.evaluate(() => window.appDMS.tabs.onNewProgram());
  await page.waitForTimeout(2500);
  // moveTabToOtherGroup creates the split itself when there isn't one.
  const split = await page.evaluate(() => {
    const tabs = window.appDMS.tabs;
    tabs.selectTab(tabs.getAllTabObjects()[1]);
    window.__ssf.run("moveTabToOtherGroup");
    tabs.selectTab(tabs.mainTabs[0]);
    window.__ssf.run("focusCodeEditor");
    return { main: tabs.mainTabs.map((t) => t.title), secondary: (tabs.secondaryTabs || []).map((t) => t.title) };
  });
  await page.waitForTimeout(1200);
  check(
    "moveTabToOtherGroup splits the tab area when there is no split yet",
    split.secondary.length === 1 && split.main.length === tabCount - 1,
    { split, tabCount },
  );
  const groupToggle = await page.evaluate(async () => {
    const focused = () => window.appDMS.tabs.getFocusedTab()?.title;
    const start = focused();
    window.__ssf.run("switchTabGroup");
    await new Promise((r) => setTimeout(r, 600));
    const other = focused();
    const otherActive = (document.activeElement.className || "").toString();
    window.__ssf.run("switchTabGroup");
    await new Promise((r) => setTimeout(r, 600));
    return { start, other, back: focused(), otherActive };
  });
  check(
    "switchTabGroup toggles between the two tab groups and focuses the editor",
    split.secondary.length === 1 &&
      groupToggle.other === split.secondary[0] &&
      groupToggle.back === groupToggle.start &&
      /textview|ace_/.test(groupToggle.otherActive),
    { split, groupToggle },
  );
  // Moving the last tab back out un-splits - which also leaves the session as we
  // found it, so this is both the check and the cleanup.
  // The main group can never be emptied - SAS Studio has no such state.
  const emptyMainRefused = await page.evaluate(async () => {
    const tabs = window.appDMS.tabs;
    // Drain the main group down to its last tab first - the refusal only applies
    // there, and the session may have brought more than one tab with it.
    for (let i = 0; i < 20 && tabs.mainTabs.length > 1; i++) {
      tabs.selectTab(tabs.mainTabs[0]);
      window.__ssf.run("moveTabToOtherGroup");
      await new Promise((r) => setTimeout(r, 600));
    }
    tabs.selectTab(tabs.mainTabs[0]);
    window.__ssf.run("moveTabToOtherGroup");
    return {
      warned: document.body.innerText.includes("Last tab in the main group"),
      main: tabs.mainTabs.map((t) => t.title),
      secondary: (tabs.secondaryTabs || []).map((t) => t.title),
    };
  });
  check(
    "moveTabToOtherGroup refuses to empty the main group",
    emptyMainRefused.warned &&
      emptyMainRefused.main.length === 1 &&
      emptyMainRefused.secondary.length === tabCount - 1,
    { emptyMainRefused, tabCount },
  );

  // Splitting, un-splitting and splitting AGAIN used to throw from inside
  // _addSecondaryTabContainer: tabsContextMenuCopyUri shared one MenuItem widget
  // between the two tab menus, and destroying the secondary menu destroyed it.
  const roundTrips = await page.evaluate(async (tabCount) => {
    const tabs = window.appDMS.tabs;
    const wait = () => new Promise((r) => setTimeout(r, 600));
    const states = [];
    // Back to one tab on the far side, which is where "move the last one out"
    // un-splits (the check above drained the main group instead).
    for (let i = 0; i < 20 && (tabs.secondaryTabs || []).length > 1; i++) {
      tabs.selectTab(tabs.secondaryTabs[0]);
      window.__ssf.run("moveTabToOtherGroup");
      await wait();
    }
    for (let i = 0; i < 3; i++) {
      // last tab out of the secondary group -> un-split
      tabs.selectTab(tabs.secondaryTabs[0]);
      window.__ssf.run("moveTabToOtherGroup");
      await wait();
      states.push({
        i,
        step: "unsplit",
        ok: !tabs.secondaryTabContainer && tabs.mainTabs.length === tabCount,
      });
      // and back out -> a brand new secondary container
      tabs.selectTab(tabs.mainTabs[tabs.mainTabs.length - 1]);
      window.__ssf.run("moveTabToOtherGroup");
      await wait();
      states.push({
        i,
        step: "resplit",
        ok:
          !!tabs.secondaryTabContainer &&
          tabs.mainTabs.length === tabCount - 1 &&
          tabs.secondaryTabs.length === 1,
      });
      // switchTabGroup must still work BOTH ways afterwards
      tabs.selectTab(tabs.mainTabs[0]);
      window.__ssf.run("switchTabGroup");
      await wait();
      const toSecondary = tabs.secondaryTabs.includes(tabs.getFocusedTab());
      window.__ssf.run("switchTabGroup");
      await wait();
      states.push({ i, step: "switch", ok: toSecondary && tabs.mainTabs.includes(tabs.getFocusedTab()) });
    }
    return states;
  }, tabCount);
  check(
    "split / un-split / re-split survives repeated round trips, switchTabGroup with it",
    roundTrips.length === 9 && roundTrips.every((s) => s.ok),
    roundTrips.filter((s) => !s.ok),
  );

  // Copy Path stays on BOTH tab menus - the shared-instance bug moved it off the
  // main one as soon as a secondary group existed.
  const copyPathItems = await page.evaluate(() => {
    const label = (m) => (m ? m.getChildren().filter((c) => c.label === "Copy Path").length : null);
    return { main: label(window.appDMS.tabs.mainTabMenu), secondary: label(window.appDMS.tabs.secondaryTabMenu) };
  });
  check("Copy Path is on both tab context menus, once each", copyPathItems.main === 1 && copyPathItems.secondary === 1, copyPathItems);

  // Moving the last tab back out un-splits - also the cleanup that leaves the
  // session as we found it.
  const unsplit = await page.evaluate(async () => {
    const tabs = window.appDMS.tabs;
    tabs.selectTab(tabs.secondaryTabs[0]);
    window.__ssf.run("moveTabToOtherGroup");
    await new Promise((r) => setTimeout(r, 600));
    return { stillSplit: !!tabs.secondaryTabContainer, main: tabs.mainTabs.map((t) => t.title) };
  });
  check(
    "moving the last tab back out un-splits the tab area",
    !unsplit.stillSplit && unsplit.main.length === tabCount,
    { unsplit, tabCount },
  );

  // unsplitTabGroups with SEVERAL tabs on the far side - the one case moving tabs
  // one at a time doesn't reach (the main group can never be emptied down to it).
  const noSplitYet = await page.evaluate(() => {
    window.__ssf.run("unsplitTabGroups");
    return document.body.innerText.includes("Tab area isn't split");
  });
  check("unsplitTabGroups warns when there is no split", noSplitYet, { noSplitYet });

  await page.evaluate(() => window.appDMS.tabs.onNewProgram());
  await page.waitForTimeout(2500);
  const bulkUnsplit = await page.evaluate(async () => {
    const tabs = window.appDMS.tabs;
    const wait = () => new Promise((r) => setTimeout(r, 600));
    // Everything but the first tab out to the right - at least two, which is the
    // case moving tabs one at a time can't reach.
    for (const t of tabs.mainTabs.slice(1)) {
      tabs.selectTab(t);
      window.__ssf.run("moveTabToOtherGroup");
      await wait();
    }
    const split = { main: tabs.mainTabs.length, secondary: (tabs.secondaryTabs || []).length, total: tabs.getAllTabObjects().length };
    const focusedBefore = tabs.getFocusedTab()?.title;
    window.__ssf.run("unsplitTabGroups");
    await wait();
    return { split, focusedBefore, focusedAfter: tabs.getFocusedTab()?.title, stillSplit: !!tabs.secondaryTabContainer, main: tabs.mainTabs.length };
  });
  check(
    "unsplitTabGroups moves every tab back and collapses the split",
    bulkUnsplit.split.secondary === bulkUnsplit.split.total - 1 &&
      bulkUnsplit.split.secondary >= 2 &&
      !bulkUnsplit.stillSplit &&
      bulkUnsplit.main === bulkUnsplit.split.total,
    bulkUnsplit,
  );
  check(
    "...keeping the focused tab focused",
    bulkUnsplit.focusedAfter === bulkUnsplit.focusedBefore,
    bulkUnsplit,
  );
  // Close the tabs this block opened - both of them, by identity rather than by
  // "the focused one", so a session that arrived with tabs keeps exactly those.
  await page.evaluate(async (baseTitles) => {
    const tabs = window.appDMS.tabs;
    for (const t of tabs.getAllTabObjects().filter((t) => !baseTitles.includes(t.title))) {
      if (t.editor) t.editor.editorContentChanged = false;
      tabs.closeTab(t);
      await new Promise((r) => setTimeout(r, 700));
    }
  }, baseTitles);

  await shutdown();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error("HARNESS ERROR:", e.message);
  await shutdown();
  process.exit(1);
});
