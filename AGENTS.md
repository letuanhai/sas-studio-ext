# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Prose here is **hard-wrapped at 120 columns**, and additionally broken at every sentence end (and at semicolons outside
parentheses), so it reads in source mode and a diff stays small — the sentence break is what stops a one-word edit from
reflowing the rest of a paragraph.
Markdown reflows it all at render time, so these breaks are purely for the source.
Keep both rules when editing, and never re-join a paragraph onto one line.
The same applies to everything under `docs/`.

**Rationale belongs in the commit message, not here.** This file and `docs/` record what the code does and which
invariants must hold;
*why* a thing was done, what was measured, and what was rejected go in the commit body, which the convention below
already requires.

## What this is

A Chromium extension (Manifest V3) that enhances SAS Studio 3.8 (a legacy Dojo 1.x web app) by monkey-patching in the
page's MAIN world.
Two main features: toggling SAS Studio's built-in editor for a modern Ace editor at runtime, and various independent UX
fixes (formerly a Tampermonkey userscript, now fully absorbed — nothing to install separately).
Everything works by reverse-engineered runtime patching.
No build step for the extension's own code (`./tools/build_lib.sh` only generates the gitignored `lib/`).

**Do not commit (or push) until the user explicitly asks.** Make and verify changes in the working tree and wait;
the user decides when — and to which branch — anything gets committed.

The repo root is the extension root ("Load unpacked" points at it): `manifest.json` at the root, all source under
`src/`, plus `assets/` (icons) and `lib/` (gitignored, generated).
So manifest entries and `chrome.scripting` `files:` lists are extension-root-relative (`src/...`), while
`options.html`/`options.js` reference the Ace lib page-relatively as `../lib/...`.
`./tools/package.sh` zips exactly `manifest.json src assets lib` (plus `CHANGELOG.md`) into `dist/`.

All extension logs are prefixed `[SS Ext]`.

## Deep documentation

Read the one that covers what you're touching;
each is self-contained.

| File | Covers |
|---|---|
| [docs/editor-swap.md](docs/editor-swap.md) | `AceEditorAdapter`, the `__ssExt` singleton, `loadNewAce`, text viewers, the command palette, popup sizing, completers, vim + vimrc, the dirty gutter, the inline editor, the diff view |
| [docs/language-servers.md](docs/language-servers.md) | The SAS and Lua language servers, ace-linters, PROC LUA `submit` blocks, definition/references/rename, the `sas` table, `src/emmylua-worker.js` |
| [docs/ss-fixes.md](docs/ss-fixes.md) | The UX actions and patches: tab/pane groups, the run indicator and single-run guard, `runFocus`, `openLogInTextTab` |
| [docs/extension-shell.md](docs/extension-shell.md) | `sw.js`, `relay.js`, `tools-meta.js`, `defaults.js`, the popup/options/changelog pages, dark mode |
| [docs/ace-custom.md](docs/ace-custom.md) | `ace-patches.js` and `src/ace/*` — the SAS and SAS Log modes, `ext-browse_ss.js` |
| [docs/development.md](docs/development.md) | Builds, tests, the live instance's rules, the dev browser, what needs an extension reload |

## Components

Everything lives in one extension, all patching the same app.

- `src/sw.js` — service worker: injects `tools-meta.js`/`ss-fixes.js`/`editor-swap.js` into the MAIN world on every
  `/SASStudio/` page load and seeds their config, pushes live storage changes (`snippets`, `aceConfig`, `browseKeys`,
  `browseFileActions`, `browsePaths`, `runFocus`) into open tabs, registers the dark-mode content scripts, and sets the
  per-tab `ON`/`OFF` badge.
- `src/relay.js` — ISOLATED-world content script, the only bridge from MAIN-world code to `chrome.storage`.
- `src/editor-swap.js` — the Ace replacement: `AceEditorAdapter`, `window.__ssExt`, both language-server clients.
  By far the largest file.
- `src/ss-fixes.js` — the independent UX fixes, split into `ACTIONS` (one-shot commands) and `PATCHES` (passive
  monkey-patches applied once at init).
  Exposes `window.__ssf`.
- `src/tools-meta.js` — the shared `SSF_TOOLS` / `SSF_BROWSE_KEYS` / `SSF_BROWSE_FILE_ACTIONS` tables and their
  lookup helpers, plus `ssfEventKey`.
  Plain script, loaded both as an extension-page `<script>` and injected into the page.
- `src/defaults.js` — the `DEFAULT_*` config objects, `importScripts()`'d by `sw.js` and `<script>`'d by `options.html`.
- `src/popup.html`/`popup.js` — the editor toggle, native-mouse toggle, "Command palette…", the per-host browse roots.
- `src/options.html`/`options.js` — all configuration, including the Ace-backed per-language snippet editor.
- `src/changelog.html`/`changelog.js` — renders the shipped `CHANGELOG.md`.
- `src/page.css` — the palette and page frame shared by the options and changelog pages.
- `src/dark.css` — the generated, committed dark theme for SAS Studio's own UI (~460 KB;
  don't hand-edit, change `tools/gen-dark-css.js` and re-run).
- `src/dark-inject.js` / `src/dark-media-auto.js` — the two content scripts that attach it as a `<link>`.
- `src/ace-patches.js` — `window.__ssExtApplyAcePatches(ace)`, reproducing the author's ace-fork changes at runtime.
- `src/ace/` — the custom Ace modules: `mode-sas.js`, `mode-saslog.js`, `snippets-sas.js`, `ext-browse_ss.js`.
- `src/lua/sas.lua` — the EmmyLua `---@meta` defs for the PROC LUA `sas` package.
- `src/emmylua-worker.js` — the Lua language server's worker half.
- `lib/` (gitignored, generated by `./tools/build_lib.sh`) — `ace/` (built from source under our own `__ssAce` module
  namespace), `ace-linters/` (byte-identical to its npm tarball), `sas-lsp/`, `emmylua-lsp/`.
- `test/units.js`, `test/options.js`, `test/smoke.js` — the three suites, cheapest first.

The editor toggle is idempotent and repeatable — no page refresh needed to switch back and forth.

## Key SAS Studio integration points

- `window.appDMS` — main app controller;
  `.tabs` (SASStudioTabs), `.projects`, `.dialogs`, `.sessionId`, `.baseURL`.
- `SAS.Editor` — the editor API surface the adapter must implement (defined in SAS Studio's own
  `resources/js/sas-commons/controls/CodeEditor.js`).
- `dijit.byId(...)` / `dijit.registry` — Dojo widget access (trees are `projects.tree`, `library.tree`,
  `destination.tree`).
- Beware: some SAS Studio methods are subtly broken by the app itself (e.g. `dijit.Tree._expandNode` is overridden to
  return undefined;
  `ss-fixes.js` re-binds the prototype original).
- The dominant pattern for patches is wrap-and-delegate: save the original method, replace it with a wrapper that calls
  through.

## Development quick reference

Setup: `npm i && npx playwright install chromium`, then `./tools/build_lib.sh` once.

| Command | What |
|---|---|
| `npm run test:units` | Pure logic. No browser, no server. |
| `npm run test:options` | Headless Chromium, no SAS instance. Seconds. |
| `npm run test:smoke` | Headless Chromium against the live instance. **Single-threaded, one at a time.** |
| `npm run dev` | Launch the dev browser with the extension loaded over CDP, and watch for reloads. |
| `./tools/dev-browser.sh reload` | Pick up a `sw.js`/`relay.js`/`manifest.json` edit without restarting the browser. |
| `npm run package` | `dist/sas-studio-ext-<version>.zip`. |

A page reload picks up everything `sw.js` injects and every resource the page fetches.
`manifest.json`, `src/sw.js`, `src/relay.js`, `src/dark-inject.js` and `src/dark-media-auto.js` additionally need an
extension reload.

The live instance is `http://sas-ue.lan/SASStudio/38/`.
**It is not rate-limited** — it is a 995 MB box, and SAS Studio leaks a ~28 MB workspace session on every page load.
So: one automated client at a time, release the sessions your run created (and only those), and recover a 503 with
`~/.claude/skills/sas-dev-server/repair.sh` rather than retrying in a loop.
The full story is in [docs/development.md](docs/development.md) — read it before automating anything against that
server.

## Commit convention

Follow the EU Component Library convention (https://ec.europa.eu/component-library/v1.15.0/eu/docs/conventions/git/):

```
<type>: <subject>

<body>

<footer>
```

No scope — type only.
Header mandatory, lines <= 100 chars.
Subject in imperative present tense, no leading capital, no trailing period;
body same style, explaining motivation and contrast with previous behaviour.
`BREAKING CHANGE:` and closed-issue links go in the footer.
A revert is `revert: <original header>` with `This reverts commit <hash>.` in the body.

Types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only
- `style` — formatting/whitespace, no code-meaning change
- `refactor` — neither fixes a bug nor adds a feature
- `perf` — performance improvement
- `test` — adding missing tests
- `chore` — build process or auxiliary tool changes

Do not append session/trailer links to commit messages.
