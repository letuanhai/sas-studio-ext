# Bundler spike: can a build step get rid of the shared `window.ace`?

Branch: `worktree-agent-a79dfd24fa969b474` (based on `de069ec`).

## The problem

Every file in an ace `src-noconflict` build starts with `ace.define(...)` — it
registers itself into whatever `window.ace` points at *when the script runs*.
SAS Studio 3.8 ships its own ace 1.x on that same global. One name, two
libraries: whichever loaded last owned every lazily loaded module, which is how
the vim `:w`/`:q`/`:wq`/`:x` ex-commands silently stopped installing (fixed in
`de069ec`).

`de069ec` fixed it by replacing SAS's ace outright and pinning `window.ace` to
ours. That works, but SAS Studio's stock editor then tokenizes against *our*
build, so every ace bump can break it silently — one shim (`ace/unicode`'s
dropped `packages` export) was already needed, with an UPGRADE CAVEAT comment
and a smoke check to catch the next one.

## Recommendation

**Don't adopt a bundler. Rename the registry namespace instead** — implemented
on this branch, one commit, ~30 lines of `build_lib.sh`.

`build_lib.sh` now rewrites the vendored build after `npm pack`:

| rewrite | where |
| --- | --- |
| `var ACE_NAMESPACE = "ace"` → `"__ssAce"` | `ace.js` loader prelude |
| `global.ace` → `global.__ssAce` | `ace.js` footer |
| `ace.define` / `ace.require` → `__ssAce.…` | every module wrapper + footer |
| (renamed back) `module.exports = function(ace) {…}` block | `ace/loader_build` — see gotcha below |

`worker-*.js` is excluded (own global, own loader copy, no collision possible).
Each rewrite is asserted, so a future ace release that refactors out from under
the sed fails the build instead of shipping a half-renamed library.

Consequences:

- Our ace lives on `window.__ssAce`. **`window.ace` is never read, written,
  deleted or pinned** — SAS's build and its stock editor are untouched.
- Module identity comes from a private registry, so a lazily loaded
  theme/mode/keybinding cannot land in the wrong library **in either
  direction** (the old pinning also silently captured SAS's own lazy loads).
- `shimOldAceCompat()` and `pinAceGlobal()` are deleted; the ace-upgrade
  compat surface is gone. An ace bump is a routine bump again.
- Nothing else changes: same per-file lazy loading, same `<script src>` loads,
  same debuggability (devtools shows the real unminified `src-noconflict`
  files, no source maps involved), same `manifest.json`,
  `web_accessible_resources` and `package.sh`, **no build step for the
  extension's own code**.

Source-side edits: `editor-swap.js` takes our library into one closure variable
(`let ace = window.__ssAce`, assigned in `doLoadNewAce`), `options.js` and
`ace-seed.js` do the same, and `src/ace/*.js` (our own ace modules —
`mode-sas.js`, `snippets-sas.js`, `ext-browse_ss.js`) carry
`__ssAce.define`/`__ssAce.require` in their source. That last change is needed
by *any* private-registry design, bundler included.

### Gotcha found the hard way

The blanket sed initially also rewrote `ace/loader_build`:

```js
module.exports = function(ace) {      // <- a PARAMETER, called as require("./loader_build")(exports)
    ace.require = require;            // module-local require
    if (typeof define === "function") ace.define = define;   // GLOBAL define -> Dojo's, on a SAS page
};
```

Renamed, that pointed ace's own bootstrap at the global object and overwrote
`window.__ssAce.define` with **Dojo's** `define` — after which nothing loaded
and SAS's ace got dragged into 404-ing lazy loads. `build_lib.sh` renames that
block back and asserts it. It is the only such site in the whole build (all
1,793 other `ace.define`/`ace.require` occurrences are wrapper positions).

## What the bundler route would have cost

Prototyped for real (`esbuild@0.25.5` + `ace-code@1.44.0`, in a scratch dir,
not wired into the extension):

| | number |
| --- | --- |
| modules registered in the entry (core + 48 themes + 4 keybindings + exts + python/lua) | 127 |
| bundle, unminified, no map | 1.74 MB |
| bundle, unminified, **inline** source map | 5.2 MB |
| esbuild build time | 33–48 ms (plus ~1.3 s `npx` wrapper, ~2 s `npm pack`) |
| script eval in-page | ~330 ms |
| eager-bundle-everything alternative (all non-worker `src-noconflict`) | 10.8 MB — not viable |

It does work in a browser: separate registry, `window.ace` untouched,
`__ssAce.require("ace/keyboard/vim")`, themes, statusbar, and our own
`__ssAce.define(...)` modules all load. Two things it costs that the rename
doesn't:

1. **A hand-maintained id registry.** A bundler erases module ids, so
   `ace.require("ace/...")` only works for ids the entry file explicitly maps.
   Our code + custom ace modules use ~25 ids today; every new one is an entry
   edit plus a rebuild. `ace/ext/*` and every mode/theme must be listed too.
2. **Re-implementing what ace's loader gives for free.** The prototype's
   `edit(..., {mode: "ace/mode/sas"})` fell back to `ace/mode/text` with
   `loader is not configured`, because ace's own `config.loadModule` consults
   `config.dynamicModules`/`$require`, not a hand-rolled registry — so every
   registered id also needs a `config.setModuleLoader` entry. Solvable, but
   it's shim code that exists only to replace a loader we already ship.

Plus the answers to the open questions in the brief:

- **Lazy loading.** Eager-bundling everything is out (10.8 MB). Dynamic
  `import()` chunks were **not** verified — they need `format=esm` + splitting,
  a module script in the page world, and a CSP check on a production server.
  The rename keeps today's per-file `<script src>` lazy loading (including the
  existing `keybinding-<name>.js` URL override), so the question doesn't arise.
- **`src/ace-patches.js` as build-time patches.** Not done, and not blocked by
  this choice: patching the extracted tarball before it lands in `lib/` works
  the same with or without a bundler (that is what `remove-pyright.patch` does
  for the LSP). It trades runtime prototype surgery for a `.patch` that must be
  rebased on every ace release; today's runtime patches are each try/catch'd and
  idempotency-guarded and cost nothing. Worth revisiting only if the runtime
  patches start silently no-op-ing across versions.
- **`ensureLsp()`'s `delete window.define` dance.** Bundling ace would **not**
  remove it. That hack exists because `ace-linters`' *UMD* bundles see Dojo's
  AMD `define` and register into Dojo instead of setting
  `window.LanguageClient`. Only bundling ace-linters itself (or vendoring its
  ESM/CJS build) would remove it — orthogonal to this spike.
- **What breaks.** Nothing found. `manifest.json`, `web_accessible_resources`,
  `package.sh` and the injection paths are unchanged. The options page was the
  one real risk (it loads ace page-relatively as `../lib/...` and used a bare
  `ace` global) — it takes `window.__ssAce` now and was verified in a headless
  browser: snippet editor, 43 theme options, patch/hotkey tables, SAS entry in
  the settings-menu mode list, status bar. `ace-linters` never touches
  `window.ace`.

## Verification

- `node test/units.js` — passes.
- `node test/smoke.js` against the live instance: **6 failures on the baseline
  (`de069ec`), the same 6 on this branch — zero delta.** All environmental: LSP
  (no `lib/sas-lsp` built here) and 5 checks that need a code tab the test
  session doesn't have (`command palette (editor focused)`, `noTreeFocusSteal`,
  `applyAceConfig live-applies`, and the two settings-menu checks).
- Smoke checks replaced/added (all passing): "our ace and SAS's are two
  separate libraries, SAS's untouched on `window.ace`", "SAS's stock editor
  still resolves everything it needs from its OWN ace" (the 5 module APIs
  `SyntaxColorerAdapter.js`/`Mode.js`/`SasLexer.js` read), "a lazily loaded
  module registers in OUR registry, not SAS's" (loads `ace/theme/monokai`
  through `config.loadModule` and checks both registries), "vim ex-commands
  install against our ace", "`window.ace` is still SAS's own build after
  deactivation".
- Ad-hoc live check: SAS's own ace answers all 5 contract modules from its own
  64-module registry and issues **zero** 4xx for `/js/ace/` — it is not being
  dragged into lazy loads.

## Dev-loop impact

Unchanged, which is the point: edit `src/**` → reload the unpacked extension →
refresh the page. No bundle, no watcher, no rebuild for our own ace modules
(`mode-sas.js` etc. are still plain files loaded by URL). `./build_lib.sh` runs
only when a vendored version changes: the ace re-vendor + rename step is ~2 s
(dominated by `npm pack`); the sed pass over the tree is sub-second.

Under the bundler this becomes: any change to `src/ace/*.js` or an ace bump
needs an `npx esbuild` run (~1.5 s wall with the npx wrapper) *and* an entry-file
edit whenever a new module id is referenced.

## What remains unsolved / when to revisit

- The rename is a *textual* rewrite of upstream output. It survives point
  releases (the assertions prove it per build), but a major ace refactor of the
  loader would need the seds re-derived.
- `lib/ace/` is no longer byte-identical to the tarball. It is still generated,
  never hand-edited, and the diff is mechanical and asserted.
- Adopt the bundler only if one of these becomes true: (a) we need real
  tree-shaking / a smaller shipped ace, (b) we move to `ace-code` source for
  build-time patches and want the fork's diffs applied verbatim, or (c) an
  upstream change makes the namespace no longer renameable. None hold today,
  and none of them is worth 5 MB, a module-id registry and a build step now.
