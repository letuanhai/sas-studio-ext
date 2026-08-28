// Renders CHANGELOG.md into changelog.html. The file ships with the extension
// (tools/package.sh puts it in the zip) and is fetched from the extension's own
// origin, so nothing here has to be kept in sync with it by hand.
//
// The "parser" only knows the four things the changelog actually uses: `##`
// headings, `-` bullets with wrapped continuation lines, plain paragraphs, and
// inline `code`/**bold**. A markdown library for that would be silly.
(async () => {
  const out = document.getElementById("changelog");
  let text;
  try {
    const res = await fetch("../CHANGELOG.md");
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    text = await res.text();
  } catch (e) {
    out.textContent = "Could not load CHANGELOG.md: " + e.message;
    return;
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const html = [];
  const versions = [];
  let mode = null; // "ul" | "p" | null

  const close = () => {
    if (mode === "ul") html.push("</li></ul>");
    else if (mode === "p") html.push("</p>");
    mode = null;
  };

  for (const line of text.split("\n")) {
    const bullet = line.match(/^- (.*)/);
    if (!line.trim()) {
      close();
    } else if (line.startsWith("# ")) {
      // The page has its own <h1>.
    } else if (line.startsWith("## ")) {
      close();
      const v = line.slice(3).trim();
      versions.push(v);
      html.push(`<h2 id="v${esc(v)}">${esc(v)}</h2>`);
    } else if (bullet) {
      if (mode === "ul") html.push("</li><li>");
      else {
        close();
        html.push("<ul><li>");
        mode = "ul";
      }
      html.push(inline(bullet[1]));
    } else if (mode) {
      html.push(" " + inline(line.trim())); // wrapped continuation of the line above
    } else {
      html.push("<p>" + inline(line.trim()));
      mode = "p";
    }
  }
  close();
  out.innerHTML = html.join("");

  // Jump links, from the versions just parsed, into the sticky left column.
  document.getElementById("versions").insertAdjacentHTML(
    "beforeend",
    versions.map((v) => `<a href="#v${esc(v)}">${esc(v)}</a>`).join(""),
  );
})();
