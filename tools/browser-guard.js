/**
 * Bounded shutdown + exit guards for the playwright scripts here
 * (test/smoke.js, tools/gen-dark-css.js).
 *
 * Why: every close path in a playwright script goes through the page, and
 * page.evaluate has NO default timeout. SAS Studio wedges its own JS thread on
 * purpose (a synchronous XHR against a busy workspace session blocks until the
 * run ends), so a shutdown that starts with "ask the page for its session id"
 * can block forever - and a script that never exits keeps a headless Chromium
 * alive with it. That is the whole leak: 42 chromium scopes started and never
 * released over one uptime, which ate the box. Nothing here is about signals
 * being unhandled - playwright installs its own SIGINT/SIGTERM/SIGHUP handlers
 * and a SIGKILL'ed node still takes its browser with it (chromium exits on CDP
 * pipe EOF, measured) - it is about the process staying ALIVE and stuck.
 *
 * So: bound every step, and if the browser still will not go, kill it.
 */
"use strict";
const { execFileSync } = require("child_process");

const STEP_TIMEOUT = 15000;

/**
 * Run `fn`, resolve either way after at most `ms`. Never rejects.
 * The timer is deliberately NOT unref'd: while a step is in flight it is the
 * only pending handle, and an unref'd one lets node decide the event loop is
 * empty and exit 0 in the middle of the shutdown (measured - the first version
 * of this file did exactly that, skipping the close entirely). It is cleared on
 * the fast path, so it never delays a normal exit.
 */
const step = (fn, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve()
      .then(fn)
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });

/**
 * Last resort. Playwright's client objects expose no browser pid, but the
 * browser is spawned as a direct child of this process, so its children are
 * it. These scripts spawn nothing else; anything left here is the browser.
 */
function killChildProcesses() {
  try {
    const pids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
    for (const pid of pids.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  } catch {} // no children left, or no pgrep
}

/**
 * Close `ctx` within a bounded time, whatever state the page is in.
 * `before` (optional) is the last thing that needs a live page - e.g. releasing
 * the workspace session - and is bounded too, so a wedged page can no longer
 * stop the close from happening.
 */
async function closeBrowser(ctx, before, ms = STEP_TIMEOUT) {
  if (before) await step(before, ms);
  if (!ctx) return;
  await step(() => ctx.close(), ms);
  const browser = ctx.browser && ctx.browser();
  if (!browser || !browser.isConnected()) return;
  await step(() => browser.close(), ms);
  if (browser.isConnected()) killChildProcesses();
}

/**
 * Signal handlers that route through `shutdown` and then actually exit, plus an
 * unref'd watchdog that force-ends a run that has stopped making progress.
 * (Playwright's own SIGTERM/SIGHUP handlers close the browser but never exit,
 * and no handler of anyone's fires for a run that simply hangs.)
 */
function armExitGuards(shutdown, watchdogMs) {
  let exiting = false;
  const bail = async (code) => {
    if (exiting) process.exit(code); // second signal: stop waiting, go now
    exiting = true;
    await shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => bail(130));
  process.on("SIGTERM", () => bail(143));
  process.on("SIGHUP", () => bail(129));
  if (watchdogMs) {
    setTimeout(() => {
      console.error(`WATCHDOG: no exit after ${Math.round(watchdogMs / 1000)}s - forcing shutdown`);
      bail(1);
    }, watchdogMs).unref();
  }
}

module.exports = { closeBrowser, armExitGuards, step, STEP_TIMEOUT };
