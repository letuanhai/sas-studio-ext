/**
 * Self-check for tools/browser-guard.js: a WEDGED page must still end in a
 * closed browser and a process that exits.
 *
 * This is the regression guard for the chromium leak - 42 headless browsers
 * started and never released over one uptime, until the box died of it. The
 * cause was never a missing close() call; it was a close that could not run,
 * because the step before it (asking the page for its workspace session id)
 * hung forever on a page whose JS thread SAS Studio had blocked.
 *
 * Needs playwright + a chromium (same NODE_PATH/CHROME_BIN recipe as smoke.js),
 * but no server: it wedges a data: URL with an infinite loop.
 *
 * Run:  node test/browser-guard-check.js
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { closeBrowser, step } = require("../tools/browser-guard");

const children = () => {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when there are none
  }
};

(async () => {
  // step() bounds a promise that never settles, and never rejects itself.
  const t0 = Date.now();
  await step(() => new Promise(() => {}), 200);
  assert.ok(Date.now() - t0 < 2000, "step() did not bound a never-settling promise");
  await step(() => Promise.reject(new Error("boom")), 200); // must not throw

  const ctx = await chromium.launchPersistentContext("", {
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chromium" }),
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("data:text/html,<title>wedge</title>");
  assert.ok(children().length > 0, "no browser child process to begin with");

  // Wedge the renderer exactly as a busy workspace session does: block the JS
  // thread outright. Nothing in the page ever answers again, so the evaluate
  // below is the unbounded await that used to strand the whole run.
  page.evaluate(() => {
    while (true) {} // eslint-disable-line no-constant-condition
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));

  const wedged = () => page.evaluate(() => document.title); // never resolves now
  const started = Date.now();
  await closeBrowser(ctx, wedged, 3000);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 20000, `closeBrowser took ${elapsed}ms on a wedged page - it is not bounded`);
  const browser = ctx.browser && ctx.browser();
  assert.ok(!browser || !browser.isConnected(), "browser still connected after closeBrowser");
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepStrictEqual(children(), [], "browser process still alive after closeBrowser");

  // Closing twice, and closing nothing, are both no-ops rather than throws -
  // shutdown runs from several paths at once (error, signal, watchdog).
  await closeBrowser(ctx, null, 3000);
  await closeBrowser(null, null, 3000);

  console.log(`PASS  wedged page closed in ${elapsed}ms, no browser process left`);
  // No process.exit(): reaching the end of the event loop IS the check that a
  // guarded run does not hang.
})();
