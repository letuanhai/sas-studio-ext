# Development

Prose here follows the same wrapping rule as `AGENTS.md`: hard-wrapped at 120 columns, broken at every sentence end.

## Setup and builds

No build step for the extension's own code.
`npm i && npx playwright install chromium` is the whole setup (install `chromium` specifically — a bare
`npx playwright install` also pulls Firefox and WebKit, whose missing system libraries look like a real failure).

`./tools/build_lib.sh` generates the gitignored `lib/`, skip-if-current via a per-component `lib/<name>/.version`:

- `lib/ace/` — ace built from source at `ACE_VERSION` with `tools/ace-namespace.patch` applied, so the registry is
  `window.__ssAce`.
  Must be the `normal` build type;
  `minimal --nc` emits empty AMD dependency arrays.
- `lib/ace-linters/` — byte-identical copy of the npm tarball's `build/`.
- `lib/sas-lsp/` — sassoftware/vscode-sas-extension at a pinned tag, Pyright stripped by `tools/remove-pyright.patch`,
  built as a ~22 MB `target: webworker` bundle.
- `lib/emmylua-lsp/` — EmmyLuaLs/emmylua-analyzer-rust at a pinned tag with `tools/emmylua-wasm.patch`, built for
  `wasm32-wasip1`.
  The only step needing a rust toolchain;
  without `cargo` it is skipped with a warning and everything else still builds.
  Its stamp is the tag PLUS a checksum of the patch — the patch changes far more often than the tag, and a tag-only
  stamp silently keeps the previous wasm.

All library versions are pinned at the top of `tools/build_lib.sh`, which is the single place to bump one.
Nothing under `lib/` is ever hand-edited: runtime tweaks go in `src/ace-patches.js`, build-level ones in the patches.

`./tools/package.sh` → `dist/sas-studio-ext-<version>.zip`, packing exactly `manifest.json src assets lib` (plus
`CHANGELOG.md`) and rebuilding `lib/` first if incomplete — so a new runtime file belongs in one of those.

`node tools/gen-dark-css.js` regenerates `src/dark.css`.
Needs a live instance, so a release must never depend on it;
the output is committed.

`package.json` is dev-time only (private, never published, not packaged): one devDependency (playwright) plus script
aliases.
It carries **no `version` field** — `manifest.json`'s is the extension's only version.
`package-lock.json` is gitignored.
Scripts: `dev`, `test` (= units, options, smoke — cheapest and most portable first), `build`, `build:force`
(`rm -rf lib` then `build`, since every step is already skip-if-current), `package`, `dist`.
`build:dark-css` is guarded on `src/dark.css` existing, so in practice it is a no-op that keeps `build` honest.

## Tests

- `npm run test:units` — pure logic, no browser, no server.
  Covers `tools-meta.js`'s key/patch helpers, `mode-saslog.js`'s %INCLUDE folding, and `editor-swap.js`'s pure helpers
  (`_sasFns`, `_procLua`, `_procLuaTokens`, `_procLuaSignature`, `_luaNav`, `_semanticScope`, `_foldNav`, `_vimMarks`,
  `_dirtyGutter`, `_popupSizing`, `_vimrc`, `applySnippets`), plus `emmylua-worker.js`'s didChange/didOpen ordering,
  configuration answer and derived workspace roots.
  `editor-swap.js` is a MAIN-world IIFE that touches nothing but `window` at load, so a `global.window = {}` stub is
  enough to require it.
- `npm run test:options` — headless Chromium with the unpacked extension and **no SAS Studio instance anywhere**, so it
  holds no workspace session and runs in seconds.
  Its own suite for exactly that reason: nothing here should be gated behind the shared box.
  Covers the options page's snippet language selector (per-language drafts, markers, storage round trip, the
  undo-manager
  reset) and the `ace/mode/saslog` severity colours — the snippet box being the one place a real ace with a real theme
  is reachable without the live server, which is the only way to answer "does anything actually paint this token?".
- `npm run test:smoke` — headless Chromium with the unpacked extension against the live instance.
  See the file header for `SS_URL`/`CHROME_BIN`.
  **Run it single-threaded** — not because the instance is rate-limited but because it runs on a 995 MB box.
- `node test/browser-guard-check.js` — regression guard for `tools/browser-guard.js`, run when you touch that file.
  No alias, since both other tests already exercise it.

Both playwright suites close their browser through `tools/browser-guard.js`: `closeBrowser` bounds every shutdown step
and force-kills the process if it still won't go, `armExitGuards` adds SIGINT/SIGTERM/SIGHUP handlers and an unref'd
watchdog.
`page.evaluate` has no default timeout and SAS Studio wedges its own JS thread whenever a run is in flight, so an
unbounded close step can hang the process forever with a live headless Chromium attached — 42 of them once started and
never exited over one uptime, until the dev box died of memory exhaustion.
Ad-hoc one-off checks run the same way, one at a time, starting from
`~/.claude/skills/sas-dev-server/examples/drive-sas.js`, which carries the same guards.

## The live instance

`http://sas-ue.lan/SASStudio/38/` (also `https://sas.lth0.net/SASStudio/38/`).
**It is NOT rate-limited.** The 503s that made runs look throttled were leaked workspace sessions.

SAS Studio creates a workspace session (`POST .../sasexec/sessions`, 2 `sas_x` processes, ~28 MB) on EVERY page load,
and its own cleanup is dead code: `webdms.js`'s `unload()` fires a synchronous `dojo.xhrDelete`, which Chrome has
blocked during page dismissal since v80.
Nothing else reclaims them promptly, and an open page pings its session every 10 s so it never goes idle.
`test/smoke.js` therefore calls `releaseSession(page)` — `DELETE ./sasexec/sessions/<appDMS.sessionId>` issued from the
page while it is still alive — before each reload and from `shutdown()`, on both the normal and the error path.

Two rules for anything automating this server:

1. **One AUTOMATED client at a time.** Check with `ssh root@sas-ue.lan 'pgrep -x sas_x | wc -l'` before and after a run;
   the count must match.
   A person with the app open in a browser is not a problem.
2. **Only ever delete session ids your own run created.** That endpoint accepts any id from any page, so enumerating and
   sweeping would kill a colleague's live session mid-edit.

If it does 503, `~/.claude/skills/sas-dev-server/repair.sh` recovers it in ~10 s.
Don't reboot, and don't retry in a loop.

## Manual testing

With a GUI: `chrome://extensions/` → reload the unpacked extension (loaded from the repo root) → refresh the SAS Studio
page → toggle with `Ctrl+.` or the popup.

Without one (headless box, ssh from a phone), `npm run dev` (= `./tools/dev-browser.sh`) replaces that loop: it launches
stable `/usr/bin/google-chrome` with `--remote-debugging-port`, installs the repo as an unpacked extension over CDP via
`tools/ext-load.js`, and prints the mode, the CDP url and the assigned `chrome-extension://<id>`, so
`chrome://extensions`
is never needed.
Headless unless `DISPLAY` is set, with a loud warning on the fallback (the symptom of dropped X11 forwarding is just "no
window appeared";
an unreachable `DISPLAY` is reported as such rather than as "extension did not load").
`PORT`/`DATA`/`CHROME_BIN`/`URL`/`WINDOW`/`CLEAN`/`FORCE`/`WATCH` override;
`URL=` empty starts on the new-tab page (written `${URL-default}`, so an empty value is a choice, not a fallback).
Each launch costs one leaked workspace session — the browser is driven by hand, so there is no `releaseSession` here.

A plain run stays in the foreground and reloads the extension on every change to the five files a page reload cannot
pick up, until Ctrl-C.
`WATCH=0` gives launch-and-return, which is what an agent wants.
`./tools/dev-browser.sh reload` is the same reload on demand from another shell — over X11 forwarding, restarting the
browser is the expensive part, so this is the normal way to pick up an edit.
It **refuses a tunnelled browser**: `Extensions.loadUnpacked` resolves its path on the BROWSER's filesystem, so
reloading the laptop's chrome from here would hand it a path that exists only on this VM.
Reload from the machine the browser runs on;
`status` says which that is.
`stop` kills it by pidfile (not `pkill -f`, whose pattern would match the launching shell);
`status` asks the browser which extension is loaded, and from WHICH PATH — that path is what tells a local dev browser
from a tunnelled one, since the laptop has the extension loaded too, out of its own checkout.
(Matching the path against this repo alone once made `status` report a plainly-loaded extension as "NOT loaded" on every
tunnelled browser;
it now falls back to the manifest name and prints the path.)
Re-running the script is a full restart and no longer wipes the user-data-dir (`CLEAN=1` for a genuine first run).

**What needs what** (measured with a purpose-built probe extension, not assumed):

| Change | Picked up by |
|---|---|
| `src/ss-fixes.js`, `src/tools-meta.js`, `src/editor-swap.js`, `src/ace-patches.js` — anything `sw.js` injects with `executeScript({files})` | page reload |
| `src/ace/*.js`, `src/lua/*.lua`, `lib/*`, `src/dark.css` — anything the page fetches over a `chrome-extension:` URL | page reload |
| `options.html`/`popup.html`/`changelog.html` and their scripts | page reload |
| `manifest.json`, `src/sw.js`, `src/relay.js`, `src/dark-inject.js`, `src/dark-media-auto.js` | extension reload, then a page reload |

A declared content script's file is cached at extension load, and `chrome.scripting.registerContentScripts` caches the
same way;
both caches are cleared by a `loadUnpacked` of an ALREADY-loaded extension and only by that.

### Traps encoded in the dev browser

- `/usr/bin/google-chrome` silently IGNORES `--load-extension`, headed as well as headless, and with
  `--disable-features=DisableLoadExtensionCommandLineSwitch` too.
  Only playwright's build honours it, which is why the smoke test uses that binary and the dev browser goes over CDP.
- `Extensions.loadUnpacked` needs no flag on stable but does NOT persist across a browser restart, so the launch
  installs it every time — **twice**, because installing an extension the profile has seen before re-uses Chrome's
  cached copy of the service-worker script and can come up running yesterday's `sw.js`.
  The second call is a reload rather than an install, so it re-reads.
- `chrome.runtime.reload()` over CDP permanently UNLOADS an extension loaded that way: no service-worker target comes
  back and every extension page then fails `ERR_BLOCKED_BY_CLIENT` until Chrome is restarted.
- The extension id is derived from the source path, the same as `--load-extension` produced, so
  `chrome.storage.local` keeps matching across restarts.
- `DISPLAY` is recorded in `$DATA/.display` at launch rather than read back from `/proc/<pid>/environ`, which chrome
  scrubs.
  The launch refuses when the running instance recorded a different `DISPLAY` than this run has (`FORCE=1` overrides),
  because a headless run silently killing a HEADED session someone is working in just makes the window vanish.
- It refuses a `PORT` something else already listens on.
  Chrome does not fail loudly there: with `127.0.0.1:9222` taken it logs one `bind() failed` and binds `[::1]:9222`
  instead, so `localhost:9222` reaches one of two browsers depending on the resolver and the readiness probe reports
  success against the wrong one.
  The default is 9333 for that reason, and the project-scoped `chrome-devtools` MCP server carries a matching
  `--browserUrl http://127.0.0.1:9333` — the two have to agree.
  That one fixed port is what lets the same MCP config serve two devices: on the phone chrome runs here (X11-forwarded),
  on the laptop `ssh -R 9333:localhost:9222` puts its CDP on this port instead.
  Use `ssh -o ExitOnForwardFailure=yes` so a stale browser here makes the laptop refuse rather than silently driving it.
- A headed window is sized to fill the display, because `--start-maximized` does NOTHING over X11 forwarding — there is
  no window manager.
  `WINDOW=1600,1000` overrides, `WINDOW=` opts out.
- The debug port stays on 127.0.0.1 regardless: Chrome accepts `--remote-debugging-address` and then silently ignores
  it, so anything off this box reaches it through ssh or not at all.
- Watching is `tools/ext-load.js --watch` (node's `fs.watch`) on the two DIRECTORIES rather than the five files: an
  editor that saves atomically leaves a per-file watch bound to the dead inode, silently never firing again.
  Events are coalesced 300 ms.
  It exits when the browser does (a 1 s `process.kill(pid, 0)`), so the shell falls through to the same cleanup Ctrl-C
  runs.
  **The caveat inotify cannot fix**: the repo is on an NFS4 mount, where inotify only fires for changes made by THIS
  client, and the 30-minute attribute cache would blind a poll too.
  Edit on this box, or run `dev-browser.sh reload` by hand.

All extension logs are prefixed `[SS Ext]`;
expect one line per toggle plus errors and warnings only.
