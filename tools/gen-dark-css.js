/**
 * Generates src/dark.css - the static dark theme for SAS
 * Studio's own UI (the Dojo/dijit app chrome; Ace themes itself).
 *
 * Why static: SAS Studio loads ~95 stylesheets, 77 of them via nested @import
 * (corporate.css -> corporate_base.css -> ~45 children -> grandchildren).
 * Dark Reader's runtime has to recursively re-fetch and re-parse that whole
 * tree on every page load and disables the originals as it goes, so a single
 * lost fetch against a slow/rate-limited server drops a whole sheet - and when
 * that sheet is dijit.css you lose both the icon background-images and
 * .dijitDisplayNone, which is why icon buttons came back as bare text labels.
 * Its MutationObserver is also ~5x slowdown on an Ace editor with the SAS LSP
 * attached (measured: 121ms vs 23ms per keystroke, main thread busy 94% of the
 * time), because Ace rewrites inline styles on every keystroke and Dark Reader
 * re-inspects each mutation.
 *
 * So we use Dark Reader for what it is good at - generating the palette - once,
 * at dev time, via exportGeneratedCSS(), and ship the result as a plain
 * stylesheet. No page-side JS, no observer, no re-fetching. Measured
 * indistinguishable from no dark mode at all.
 *
 * The output is committed; you only need to re-run this when SAS Studio's own
 * CSS changes or you want to re-tune the palette.
 *
 * Run:  node tools/gen-dark-css.js
 * Env:  SS_URL      SAS Studio URL      (default http://sas-ue.lan/SASStudio/38/)
 *       CHROME_BIN  Chromium executable (default: playwright's bundled chromium)
 * Needs `playwright` resolvable (see test/smoke.js's header for the NODE_PATH /
 * CHROME_BIN recipe when it is only present as an npx cache) and network access
 * to npm for the pinned Dark Reader build. Dark Reader is a dev-time tool only -
 * it is never vendored into lib/ and never ships in the extension.
 */
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DARKREADER_VERSION = "4.9.128";
const ROOT = path.resolve(__dirname, "..");
const URL = process.env.SS_URL || "http://sas-ue.lan/SASStudio/38/";

// Palette knobs. Dark Reader's own defaults with a touch of warmth - this is
// the one place to re-tune the look.
const THEME = { brightness: 100, contrast: 90, sepia: 10 };

// -- get the pinned Dark Reader build (same `npm pack` idiom as build_lib.sh) --
function darkReaderSource() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "darkreader-"));
  execFileSync("npm", ["pack", "--silent", `darkreader@${DARKREADER_VERSION}`, "--pack-destination", tmp], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", path.join(tmp, tgz), "-C", tmp]);
  const src = fs.readFileSync(path.join(tmp, "package", "darkreader.js"), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  return src;
}

// -- post-processing ----------------------------------------------------------

/**
 * Walks top-level rule blocks (recursing into at-rule bodies like @layer) and
 * drops the ones `dropRule(selector)` rejects, running the surviving bodies
 * through `mapBody`. Dark Reader's output is machine-generated and uniform -
 * every block opens with `<selector> {` at end of line and closes with `}` on
 * its own line - so a brace-depth scan is enough and stays readable. Base64
 * data URIs can't contain braces, so nothing here needs string awareness.
 */
function filterCss(css, dropRule, mapBody) {
  const lines = css.split("\n");
  const out = [];
  const count = (s, ch) => (s.match(ch) || []).length;
  for (let i = 0; i < lines.length; ) {
    if (!/\{\s*$/.test(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    let depth = 0;
    let j = i;
    do {
      depth += count(lines[j], /\{/g) - count(lines[j], /\}/g);
      j++;
    } while (depth > 0 && j < lines.length);
    const block = lines.slice(i, j);
    const selector = lines[i].replace(/\s*\{\s*$/, "");
    if (selector.trimStart().startsWith("@")) {
      out.push(block[0], ...filterCss(block.slice(1, -1).join("\n"), dropRule, mapBody).split("\n"), block[block.length - 1]);
    } else if (!dropRule(selector)) {
      out.push(block[0], ...mapBody(block.slice(1, -1)), block[block.length - 1]);
    }
    i = j;
  }
  return out.join("\n");
}

// Colour properties only. Our <link> goes in at document_start, i.e. BEFORE the
// page's own stylesheets, so a same-specificity rule of ours loses every tie -
// Dark Reader never needs !important because its runtime appends its <style>
// elements last, after everything has loaded, and we can't. Measured on the
// live app: `html`'s background changed (that rule already carried !important)
// while `body`'s did not.
//
// Restricted to colours on purpose. Dark Reader also emits border-width /
// border-style / background-size / background-repeat, and !important on those
// would start overriding the inline layout styles Dojo writes on its widgets.
// Nothing here can move a box.
const IMPORTANT_PROPS = new Set([
  "background-color",
  "background-image",
  "color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "outline-color",
  "box-shadow",
  "text-shadow",
  "text-decoration-color",
  "list-style-image",
  "fill",
  "stroke",
]);

function postProcess(css) {
  const dropped = { ace: 0, imageUrl: 0 };
  let marked = 0;
  let unparsed = 0;
  const result = filterCss(
    css,
    (selector) => {
      // Ace ships its own themes and our adapter picks a dark one; the app's
      // stale ace 1.x styles must not be recoloured underneath it either.
      if (selector.includes("ace_")) {
        dropped.ace++;
        return true;
      }
      return false;
    },
    (body) =>
      body.filter((line) => {
        // Every url() in the export is a straight copy of SAS Studio's own
        // image - image analysis is off, so Dark Reader never recoloured one.
        // None of them survive the move into our stylesheet: the absolute ones
        // are baked to whatever host this ran against, and the relative ones
        // were relative to the sheet they came from (e.g. sasIcons/sasdark/)
        // and would resolve against the page root instead - which is how
        // .dijitTreeIcon ended up pointing at /SASStudio/38/16_png/*.png.
        // Dropping the declaration lets the app's own rule apply, correctly
        // resolved, which is what we wanted all along. Keeps
        // `background-image: initial`, which is Dark Reader deliberately
        // removing a gradient.
        if (/background-image:.*url\(/.test(line)) {
          dropped.imageUrl++;
          return false;
        }
        return true;
      }).map((line) => {
        const m = /^(\s*)([a-z-]+)\s*:\s*(.+?)\s*;\s*$/.exec(line);
        if (!m) {
          if (line.trim()) unparsed++;
          return line;
        }
        const [, indent, prop, value] = m;
        if (!IMPORTANT_PROPS.has(prop) || /!\s*important/.test(value)) return line;
        marked++;
        return `${indent}${prop}: ${value} !important;`;
      }),
  );
  return { css: result, dropped, marked, unparsed };
}

(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chromium" }),
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".dijitTreeNode", { state: "attached", timeout: 60000 });
  await page.waitForTimeout(4000);

  // Which selectors need their artwork inverted, straight from the app's own
  // stylesheets - so this tracks whatever icons SAS ships rather than a
  // hand-maintained class list.
  //
  // It has to be decided per icon, not blanket: SAS ships BOTH dark artwork
  // (sasIcons/sasdark/*, meant for a light background - the toolbar and tree)
  // and light artwork (sasIcons/saslight/*, already meant for the dark blue
  // banner). Inverting the whole lot turned the banner's white glyphs into
  // black blobs. So measure each image's actual luminance and invert only the
  // dark ones. Same-origin, so the canvas stays readable.
  //
  // This MUST run before DarkReader.enable(): afterwards the sheets it walks
  // are Dark Reader's rewrites, whose url()s no longer resolve, every image
  // fails to load, and everything silently measures as "not dark".
  const iconSelectors = await page.evaluate(async () => {
    const byUrl = new Map(); // absolute url -> selectors painting it
    const walk = (sheet) => {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        return;
      }
      for (const rule of rules) {
        if (rule.styleSheet) walk(rule.styleSheet);
        else if (rule.style) {
          // rule.style gives the url exactly as authored - relative, e.g.
          // "16_png/Folder.png" or "../images/.../Folder.png". Only
          // getComputedStyle resolves; here we have to do it ourselves, against
          // the sheet that declared it (the icon sheets live inside
          // sasIcons/<variant>/, so this matters).
          const m = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.backgroundImage || "");
          if (!m || m[1].startsWith("data:")) continue;
          let url;
          try {
            url = new URL(m[1], sheet.href || document.baseURI).href;
          } catch (e) {
            continue;
          }
          if (!byUrl.has(url)) byUrl.set(url, []);
          byUrl.get(url).push(rule.selectorText);
        }
      }
    };
    for (const s of document.styleSheets) walk(s);

    // Mean luminance over the non-transparent pixels.
    const classify = async (url) => {
      const img = await new Promise((res) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => res(null);
        i.src = url;
      });
      if (!img || !img.width) return "failed";
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 40) continue; // ignore near-transparent padding
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        n++;
      }
      if (n === 0) return "failed";
      return sum / n < 128 ? "dark" : "light";
    };

    const out = { invert: [], keep: [], failed: [] };
    for (const [url, selectors] of byUrl) {
      const verdict = await classify(url);
      if (verdict === "dark") out.invert.push(...selectors);
      else if (verdict === "light") out.keep.push(...selectors);
      else out.failed.push(url);
    }
    // `filter: invert()` inverts everything the element paints - its own
    // background-color and its children included - which is harmless on an
    // icon-sized box but wrong when the same artwork is also painted as the
    // background of a big container. `.emptyWorkspaceSplash` is #tabsBC itself
    // (the whole workspace area, shown when no tab is open), so inverting it
    // turned the dark empty workspace light.
    // ponytail: literal list - a size check would need the element to be in the
    // DOM and laid out at generation time, which for this one depends on
    // whether the session happens to have a tab open.
    const NOT_AN_ICON = [".emptyWorkspaceSplash"];
    return {
      invert: [...new Set(out.invert)].filter((sel) => !NOT_AN_ICON.some((c) => sel.includes(c))),
      keep: [...new Set(out.keep)],
      failed: out.failed,
      urls: byUrl.size,
    };
  });
  console.log(
    `icons: ${iconSelectors.urls} images -> ${iconSelectors.invert.length} selectors inverted, ` +
      `${iconSelectors.keep.length} left alone, ${iconSelectors.failed.length} unreadable`,
  );
  if (iconSelectors.invert.length === 0) {
    throw new Error("no dark icons found - SAS ships dark 'sasdark' artwork, so this is a bug in the walk");
  }

  // Dark Reader's UMD wrapper would register into Dojo's AMD registry instead of
  // setting window.DarkReader (same trap ensureLsp() dodges for ace-linters).
  await page.evaluate(() => {
    window.__savedDefine = window.define;
    delete window.define;
  });
  await page.addScriptTag({ content: darkReaderSource() });
  await page.evaluate(() => {
    window.define = window.__savedDefine;
    delete window.__savedDefine;
  });

  const generated = await page.evaluate(async (theme) => {
    window.DarkReader.enable(theme, {
      // Image analysis is per-rendered-element and asynchronous: Dark Reader
      // only bakes an inverted data URI for icons that happened to be on
      // screen. That made the export non-deterministic and left most icons
      // (tree, menus, dialogs) as plain `background-color: transparent` on a
      // dark background. Turning it off entirely makes the export reproducible
      // and lets one uniform rule (below) own every icon instead.
      ignoreImageAnalysis: ["*"],
    });
    await new Promise((r) => setTimeout(r, 6000));
    return window.DarkReader.exportGeneratedCSS();
  }, THEME);


  await ctx.close();

  const { css, dropped, marked, unparsed } = postProcess(generated);

  // A background-image can't be recoloured by CSS, so inverting the element is
  // the only generic option. hue-rotate puts the colour back on the coloured
  // icons after the invert.
  const icons =
    "\n/* Icons: only the artwork that measured dark (sasIcons/sasdark/* and\n" +
    " * friends). The banner's light artwork is deliberately left alone. */\n" +
    iconSelectors.invert.join(",\n") +
    " {\n    filter: invert(1) hue-rotate(180deg);\n}\n";

  // The one thing a static sheet structurally cannot see: backgrounds SAS
  // Studio hard-codes as inline styles from its own JS (the busy dialog's
  // content area does `style="background: white"`), since there is no rule to
  // rewrite. An inline style can only be beaten with !important, and only
  // reached by matching the attribute itself.
  //
  // A sweep of the whole document across the main view, the expanded navigation
  // tree and an open dialog found exactly one such patch, so this stays a
  // narrow, literal rule rather than a general inline-style engine.
  // ponytail: if more light patches turn up, widen the selector list here -
  // re-run tools/probe for the sweep rather than guessing.
  const inlineFixes =
    "\n/* Inline backgrounds hard-coded by SAS Studio's own JS. */\n" +
    '[style*="background: white"],\n[style*="background:white"],\n' +
    '[style*="background-color: white"],\n[style*="background-color:white"] {\n' +
    "    background-color: var(--darkreader-neutral-background) !important;\n}\n";

  // The Results tab is the other thing this generator structurally cannot see:
  // SAS Studio inlines the run's ODS HTML into the app's own DOM under a
  // per-run .ods_<uuid> class (id="ods_<uuid>") with its own scoped <style>
  // block, which only exists after a program has run.
  const odsFixes = `
/* Results tab: the ODS HTML output is inlined into the app's own DOM under a
 * per-run .ods_<uuid> class (id="ods_<uuid>"), carrying its own <style> block,
 * so nothing Dark Reader saw on the app page can reach it. Its default
 * (HTMLBlue) palette is four near-white backgrounds and three dark text
 * colours, so flatten those here rather than remapping ~60 ODS classes.
 * ponytail: ODS graphics are PNGs and stay light - inverting them would wreck
 * real colours; revisit only if graph-heavy output turns out to matter.
 */
[id^="ods_"] {
    background-color: var(--darkreader-neutral-background) !important;
    color: var(--darkreader-neutral-text) !important;
}
[id^="ods_"] * {
    background-color: transparent !important;
    color: inherit !important;
    border-color: var(--darkreader-border-cccccc, #4a4a4a) !important;
}
[id^="ods_"] [class*="header"],
[id^="ods_"] [class*="footer"],
[id^="ods_"] .batch {
    background-color: var(--darkreader-background-eeeeee, #2f3031) !important;
}
[id^="ods_"] a:link {
    color: #6ea8fe !important;
}
[id^="ods_"] a:visited,
[id^="ods_"] a:active {
    color: #c58af9 !important;
}
`;

  const banner =
    "/* Generated by tools/gen-dark-css.js - do not edit by hand.\n" +
    ` * Dark Reader ${DARKREADER_VERSION}, theme ${JSON.stringify(THEME)}.\n` +
    " * Dark theme for SAS Studio's own UI only; Ace themes itself.\n" +
    " */\n";

  // Everything goes in a cascade layer, which is what lets us win against SAS
  // Studio's own !important rules.
  //
  // Marking our colours !important (above) beats the app's NORMAL declarations,
  // but not its important ones - `.lineStatusBar` is `!important` in SAS's own
  // CSS, so it tied with ours on origin, importance and specificity, and ties
  // are broken by order, where a content script's stylesheet always comes
  // first. Cascade layers reverse layer order for important declarations, and
  // unlayered important declarations rank LAST among them - so any layered
  // important declaration beats an unlayered one. One wrapper, and every such
  // collision resolves our way without hand-listing selectors.
  //
  // Normal (non-!important) declarations in here - background-repeat,
  // border-width - now rank below the page's unlayered ones, but they lost
  // those ties on order anyway, so nothing regresses.
  const body = "@layer ssext-dark {\n" + css + icons + inlineFixes + odsFixes + "\n}\n";
  // One file for both modes: "follow system" is the media attribute on the
  // <link> src/dark-inject.js creates, not a second, media-wrapped copy.
  fs.writeFileSync(path.join(ROOT, "src", "dark.css"), banner + body);

  console.log(
    `generated ${(generated.length / 1024).toFixed(0)} KB -> ${(body.length / 1024).toFixed(0)} KB ` +
      `(dropped ${dropped.ace} ace rules, ${dropped.imageUrl} background-image declarations; ` +
      `marked ${marked} colour declarations !important; ` +
      `icons: ${iconSelectors.invert.length} inverted, ${iconSelectors.keep.length} left alone)`,
  );
})();
