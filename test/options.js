/**
 * Options-page checks: headless Chromium with the unpacked extension, and NO
 * SAS Studio instance anywhere - every check here runs against
 * chrome-extension://<id>/src/options.html, which is why this is its own suite
 * rather than a block in test/smoke.js. That suite needs the live server, holds
 * a workspace session per page load and takes minutes; this one needs neither
 * and runs in seconds, so it must not be gated behind it.
 *
 * Run:   npm run test:options   (test/units.js first, test/smoke.js after)
 * Setup: npm i && npx playwright install chromium   (same as smoke.js)
 *
 * Covers the snippet language selector: the shared snippet-file mode, the
 * per-language drafts and all-language save, the markers and the storage round
 * trip - and,
 * the reason it exists, that Ctrl+Z after a language switch cannot pull the
 * previous language's text into this one.
 */
const { chromium } = require("playwright");
const { closeBrowser, armExitGuards } = require("../tools/browser-guard");

const EXT = require("path").resolve(__dirname, "..");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

// The page's own editor/select, driven the way the user does.
const pick = (page, lang) =>
  page.evaluate((lang) => {
    const select = document.getElementById("snippet-lang");
    select.value = lang;
    select.dispatchEvent(new Event("change"));
  }, lang);
const boxText = (page) => page.evaluate(() => window.__ssAce.edit("snippets-editor").getValue());
const setBox = (page, text) =>
  page.evaluate((text) => window.__ssAce.edit("snippets-editor").setValue(text, -1), text);
const optionText = (page, lang) =>
  page.evaluate((lang) => [...document.getElementById("snippet-lang").options].find((o) => o.value === lang).textContent, lang);
const snippetCaptions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const ace = window.__ssAce;
        const editor = ace.edit("snippets-editor");
        ace
          .require("ace/ext/language_tools")
          .snippetCompleter.getCompletions(
            editor,
            editor.session,
            editor.getCursorPosition(),
            "",
            (_error, rows) => resolve(rows.map((row) => row.caption))
          );
      })
  );
const loadScript = (page, src) =>
  page.evaluate(
    (src) =>
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      }),
    src
  );

(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  armExitGuards(() => closeBrowser(ctx));

  const page = ctx.pages()[0] || (await ctx.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("requestfailed", (request) => errors.push(request.url() + ": " + request.failure()?.errorText));

  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      snippets: { snippets: "snippet snp\n\texpanded ${1:value}\n" },
    });
  });
  await page.goto(`chrome-extension://${id}/src/options.html`);
  await page.waitForSelector("#snippet-lang option", { state: "attached" });

  const langs = await page.evaluate(() => {
    const o = [...document.getElementById("snippet-lang").options].map((x) => x.value);
    return { count: o.length, sas: o.includes("sas"), lua: o.includes("lua"), saslog: o.includes("saslog") };
  });
  check("the language list comes from ace/ext/modelist, our own modes included", langs.count > 100 && langs.sas && langs.lua && langs.saslog, langs);

  const start = await page.evaluate(() => ({
    lang: document.getElementById("snippet-lang").value,
    mode: window.__ssAce.edit("snippets-editor").session.getMode().$id,
    text: window.__ssAce.edit("snippets-editor").getValue(),
  }));
  check(
    "it opens on SAS, in snippet mode, holding the default snippets",
    start.lang === "sas" && start.mode === "ace/mode/snippets" && start.text.includes("snippet lua"),
    start
  );
  await page.waitForFunction(() => {
    const snippets = window.__ssAce.require("ace/snippets").snippetManager.snippetMap.snippets;
    return snippets && snippets.some((snippet) => snippet.name === "snip");
  });
  const completion = await page.evaluate(async () => {
    const ace = window.__ssAce;
    const editor = ace.edit("snippets-editor");
    const tools = ace.require("ace/ext/language_tools");
    const run = (completer) =>
      new Promise((resolve) =>
        completer.getCompletions(
          editor,
          editor.session,
          editor.getCursorPosition(),
          "",
          (_error, rows) => resolve(rows)
        )
      );
    const [text, snippets] = await Promise.all([run(tools.textCompleter), run(tools.snippetCompleter)]);
    return {
      onlyRequestedCompleters:
        editor.completers.length === 2 &&
        editor.completers.includes(tools.textCompleter) &&
        editor.completers.includes(tools.snippetCompleter),
      basic: editor.getOption("enableBasicAutocompletion"),
      live: editor.getOption("enableLiveAutocompletion"),
      expand: editor.getOption("enableSnippets"),
      text: text.map((row) => row.value),
      snippets: snippets.map((row) => row.caption),
    };
  });
  check(
    "text and snippet completion are enabled without a language-keyword completer",
    completion.onlyRequestedCompleters &&
      completion.basic &&
      completion.live &&
      completion.expand &&
      completion.text.includes("proc") &&
      completion.snippets.includes("snip") &&
      completion.snippets.includes("snp"),
    completion
  );

  await pick(page, "lua");
  const lua = await page.evaluate(() => ({
    mode: window.__ssAce.edit("snippets-editor").session.getMode().$id,
    text: window.__ssAce.edit("snippets-editor").getValue(),
  }));
  check("switching language keeps the editor in snippet mode", lua.mode === "ace/mode/snippets", lua);
  check("...and the box holds that language's (here empty) snippets", lua.text === "", lua);

  // The regression guard this suite exists for: one session holds every language
  // in turn, so without an undo reset in show() a Ctrl+Z here restores the SAS
  // text into the Lua box - and the change handler then saves it AS Lua.
  // Exactly ONE press: a second one would undo the load of the SAS text itself
  // and land back on "", which is the right answer for the wrong reason.
  await page.click("#snippets-editor");
  await page.keyboard.press("Control+z");
  const afterUndo = await boxText(page);
  check("Ctrl+Z after a language switch cannot pull in the previous language's text", afterUndo === "", { afterUndo: afterUndo.slice(0, 40) });
  check("...and that language's draft is untouched by it", (await optionText(page, "lua")).trim() === "Lua", await optionText(page, "lua"));

  await setBox(page, "snp");
  await page.evaluate(() => {
    const editor = window.__ssAce.edit("snippets-editor");
    editor.navigateFileEnd();
    editor.execCommand("expandSnippet");
  });
  check(
    "a user snippet from the snippets scope expands while another target language is selected",
    (await boxText(page)) === "expanded value",
    await boxText(page)
  );
  await setBox(page, "");
  await page.evaluate(() => window.__ssAce.edit("snippets-editor").session.getUndoManager().reset());

  await setBox(page, "snippet hi\n\tprint(${1:value})\n");
  const snippetTokens = await page.evaluate(() => {
    const session = window.__ssAce.edit("snippets-editor").session;
    return [session.getTokens(0), session.getTokens(1)];
  });
  check(
    "snippet-file syntax is highlighted",
    snippetTokens[0].some((t) => t.type === "constant.language.escape" && t.value === "snippet") &&
      snippetTokens[1].some((t) => t.type === "markup.list"),
    snippetTokens
  );
  check(
    "an edit marks the language unsaved",
    (await optionText(page, "lua")).endsWith(" *"),
    await optionText(page, "lua")
  );

  await pick(page, "sas");
  check("switching away does not write the edit", (await boxText(page)).includes("snippet lua"), null);
  await setBox(page, "snippet sas-draft\n\t$1\n");
  await pick(page, "snippets");
  await setBox(page, "snippet snp2\n\tsecond ${1:value}\n");
  await pick(page, "lua");
  check(
    "switching back restores the unsaved draft",
    (await boxText(page)) === "snippet hi\n\tprint(${1:value})\n",
    await boxText(page)
  );
  const draftSnippetCompletions = await snippetCaptions(page);
  check(
    "leaving the snippets scope previews its draft under another target language",
    draftSnippetCompletions.includes("snp2") && !draftSnippetCompletions.includes("snp"),
    draftSnippetCompletions
  );

  await page.click("#save-snippets");
  await page.waitForFunction(() =>
    chrome.storage.local
      .get("snippets")
      .then(
        ({ snippets }) =>
          snippets &&
          snippets.lua === "snippet hi\n\tprint(${1:value})\n" &&
          snippets.sas === "snippet sas-draft\n\t$1\n"
      )
  );
  const stored = await page.evaluate(() => chrome.storage.local.get("snippets").then((r) => r.snippets));
  check(
    "Save writes every language at once",
    stored.lua === "snippet hi\n\tprint(${1:value})\n" && stored.sas === "snippet sas-draft\n\t$1\n",
    stored
  );
  check(
    "...and all unsaved markers become has-snippets markers",
    (await optionText(page, "lua")).endsWith(" •") &&
      (await optionText(page, "sas")).endsWith(" •") &&
      (await optionText(page, "snippets")).endsWith(" •"),
    {
      lua: await optionText(page, "lua"),
      sas: await optionText(page, "sas"),
      snippets: await optionText(page, "snippets"),
    }
  );
  const savedSnippetCompletions = await snippetCaptions(page);
  check(
    "Save refreshes snippets-scope definitions in the snippet editor",
    savedSnippetCompletions.includes("snp2") && !savedSnippetCompletions.includes("snp"),
    savedSnippetCompletions
  );

  // Emptying a language with no default drops it; SAS keeps an explicit "" so
  // DEFAULT_SNIPPETS cannot come back.
  await setBox(page, "");
  await pick(page, "sas");
  await setBox(page, "");
  await page.click("#save-snippets");
  await page.waitForFunction(() =>
    chrome.storage.local.get("snippets").then(({ snippets }) => snippets && snippets.sas === "" && !("lua" in snippets))
  );
  const cleared = await page.evaluate(() => chrome.storage.local.get("snippets").then((r) => r.snippets));
  check(
    "an emptied language is dropped, an emptied default is kept as \"\"",
    cleared.sas === "" && !("lua" in cleared),
    cleared
  );

  // The markers have to stay a SUFFIX: a <select>'s type-ahead prefix-matches
  // the option text, and with ~200 languages that is the only way to reach one.
  check("every option still starts with its caption (type-ahead)", (await optionText(page, "sas")).startsWith("SAS"), await optionText(page, "sas"));

  // ---------------------------------------------------------------------------
  // The saslog mode's severity colours. The snippet box is a real Ace with a
  // real theme, which is the only way to answer "does anything actually paint
  // this token?" - the trap src/ace/mode-saslog.js's token-name comment names.
  await loadScript(page, "../lib/ace/src-noconflict/mode-python.js");
  await loadScript(page, "../lib/ace/src-noconflict/mode-lua.js");
  await loadScript(page, "ace/mode-sas.js");
  await loadScript(page, "ace/mode-saslog.js");
  const LOG = [
    "1          data x;",
    "NOTE: The data set WORK.X has 1 observations and 1",
    "      variables.",
    "2          put 'unterminated;",
    "ERROR 22-322: Syntax error, expecting one of the following: ;.",
    "      Some more detail.",
    "",
    "      indented text after a blank line",
    "WARNING: Apparent symbolic reference X not resolved.",
    "INFO: Index i not used.",
    "DEBUG: loop",
    "3          run;",
    "error: my own put output",
    "warning: still my own",
    "4          proc lua;",
    "5          submit;",
    "NOTE: inside an embedded block",
    "6          endsubmit;",
  ];
  await pick(page, "saslog");
  await page.evaluate((text) => {
    const ace = window.__ssAce;
    const session = ace.createEditSession(text);
    session.setMode(new (ace.require("ace/mode/saslog").Mode)());
    session.setUseWorker(false);
    const editor = ace.edit("snippets-editor");
    // This fixture renders log tokens; it does not use SAS snippet expansion.
    editor.setOption("enableSnippets", false);
    editor.setSession(session);
  }, LOG.join("\n"));
  const { tokens, states } = await page.evaluate((n) => {
    const session = window.__ssAce.edit("snippets-editor").session;
    const rows = [...Array(n).keys()];
    return {
      tokens: rows.map((r) => session.getTokens(r).map((t) => [t.type, t.value])),
      states: rows.map((r) => session.getState(r)),
    };
  }, LOG.length);
  const only = (r, type) => tokens[r].length === 1 && tokens[r][0][0] === type && tokens[r][0][1] === LOG[r];
  const none = (r) => tokens[r].every((t) => !/^saslog_/.test(t[0]));

  check("a marker line is one whole-line token", only(1, "saslog_note"), tokens[1]);
  check("indented continuations do not inherit severity colours", none(2) && none(5), [tokens[2], tokens[5]]);
  check("indented text after a blank line has no severity colour", none(7), tokens[7]);
  check("the numbered form (ERROR 22-322:) counts as a marker", only(4, "saslog_error"), tokens[4]);
  // The marker must be recognized inside row 3's string state and return to
  // start, so the following line resumes ordinary SAS highlighting.
  check(
    "an error after an unbalanced quote resets the tokenizer",
    states[3] !== "start" && only(4, "saslog_error") && states[4] === "start" && none(5),
    { before: states[3], after: states[4], following: tokens[5] }
  );
  check("all five markers are distinguished", only(8, "saslog_warning") && only(9, "saslog_info") && only(10, "saslog_debug"), [tokens[8], tokens[9], tokens[10]]);
  // ...and the reset leaves row 11 back on the SAS rules rather than inside
  // row 3's string, which is what its line-number token being numeric shows.
  check("non-marker lines keep the SAS highlighting", none(0) && none(11) && tokens[0].some((t) => /keyword/.test(t[0])) && tokens[11][0][0] === "constant.numeric.sas", [tokens[0], tokens[11]]);
  // Deliberate - see the rule's comment in src/ace/mode-saslog.js. This pins the
  // BEHAVIOUR, not which rule set the flag: `start` is case-insensitive from the
  // SAS rules too, so it takes stripping BOTH to stop it matching, and a suite
  // cannot mutate two files (measured by hand instead).
  check("a lower-case marker counts too", only(12, "saslog_error") && only(13, "saslog_warning"), [tokens[12], tokens[13]]);
  // The stack clear in `restart`: a NOTE inside a PROC LUA submit block would
  // otherwise carry that block's state stack to the end of the file.
  check(
    "a marker inside an embedded block drops the block's state stack",
    Array.isArray(states[15]) && only(16, "saslog_note") && states[16] === "start" && states[17] === "start",
    { before: states[15], after: states[16], following: states[17] }
  );

  const paint = (theme) =>
    page.evaluate(
      (theme) =>
        new Promise((done) => {
          const editor = window.__ssAce.edit("snippets-editor");
          editor.setTheme(theme, () =>
            setTimeout(() => {
              const layer = editor.renderer.container.querySelector(".ace_text-layer");
              const at = (cls) => {
                const el = layer.querySelector("." + cls);
                return el && getComputedStyle(el).color;
              };
              done({
                dark: editor.renderer.container.classList.contains("ace_dark"),
                plain: getComputedStyle(layer).color,
                error: at("ace_saslog_error"),
                note: at("ace_saslog_note"),
              });
            }, 150)
          );
        }),
      theme
    );

  const light = await paint("ace/theme/chrome");
  check("light theme: the marker colours are painted, and differ from plain text", light.error === "rgb(204, 0, 0)" && light.note === "rgb(0, 87, 184)" && light.error !== light.plain, light);
  const dark = await paint("ace/theme/gruvbox");
  check("dark theme: the ace_dark half wins", dark.dark && dark.error === "rgb(255, 107, 107)" && dark.note === "rgb(111, 179, 255)" && dark.error !== dark.plain, dark);

  check("no console errors on the options page", errors.length === 0, errors.slice(0, 3));

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  await closeBrowser(ctx);
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
