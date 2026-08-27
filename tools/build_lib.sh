#!/bin/sh
# Build/refresh everything under lib/ - the single place third-party library
# versions are recorded and bumped. lib/ is gitignored: it contains only
# artifacts this script (re)generates.
#
#   lib/ace/         ace src-noconflict build (+ types), built from
#                    ajaxorg/ace with its module registry renamed to
#                    window.__ssAce via tools/ace-namespace.patch
#   lib/ace-linters/ the two ace-linters UMD bundles needed to drive an
#                    external LSP server over a web worker (the other ~24
#                    build files are its own in-browser services, unused)
#   lib/sas-lsp/     SAS language server browser bundle, built from
#                    sassoftware/vscode-sas-extension with the embedded
#                    Pyright (Python LSP, ~6 MB) stripped via
#                    tools/remove-pyright.patch
#
# The ace-linters copy is byte-identical to its tarball bar one blanked-out
# unpkg URL, and the ace build bar two dropped snippet files - both are MV3
# remote-hosted-code strings the Chrome Web Store rejects, see the comments at
# each spot. Never hand-edit lib/ (runtime tweaks belong in src/ace-patches.js). Both source builds are skipped
# while lib/<name>/.version already records the version being asked for: ace
# takes a couple of minutes, the LSP (npm ci + two webpack builds) many.
#
# Requires: npm, git, node >= 18, network.
# Usage: ./tools/build_lib.sh     (tools/package.sh runs it automatically if lib/ is incomplete)
#   BUILD_DIR=<dir> ./tools/build_lib.sh   # override the LSP clone/build location
set -e
cd "$(dirname "$0")/.." # repo root - lib/ and tools/ are relative to it

ACE_VERSION=v1.43.3 # release tag of ajaxorg/ace (ace-builds is its build output)
ACE_REPO=https://github.com/ajaxorg/ace
ACE_NAMESPACE=__ssAce
ACE_LINTERS_VERSION=2.2.0
SAS_LSP_VERSION=v1.20.0 # release tag of sassoftware/vscode-sas-extension
SAS_LSP_REPO=https://github.com/sassoftware/vscode-sas-extension

ROOT=$PWD
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# -- lib/ace: a src-noconflict build whose module registry is window.__ssAce,
# not window.ace (the rest of the build - src/, src-min*/, demo/ - never ships)
#
# Every file in a stock src-noconflict build registers itself with
# `ace.define(...)`, i.e. into whatever window.ace points at when the script
# runs - the same global SAS Studio's own (1.x) ace lives on. One name, two
# libraries: whoever loaded last owned every lazily loaded module, which is how
# vim's :w/:q/:wq/:x once landed in SAS's registry and silently never
# installed. A namespace of our own gives the two libraries separate
# registries, so window.ace stays SAS's, untouched, for good - no swapping, no
# pinning, no compat shims for SAS's stock editor.
#
# ace's build already supports this (`namespace()` filter, `opts.ns`), it just
# isn't reachable from outside; tools/ace-namespace.patch exposes it
# as $ACE_NS and fixes the two places upstream's own option falls short (the
# sanity check reads the global by hardcoded name; the worker prelude publishes
# itself as `window.ace` while its module bodies get renamed). So we build from
# source rather than rewriting the published tarball. Byte-for-byte checks: a
# stock (ACE_NS unset) build of this tag reproduces the ace-builds npm tarball
# exactly, and this build differs from it only in the namespace.
#
# It has to be the `normal` type (all four variants): src-noconflict's AMD
# dependency arrays come from the cached plain build in the same process, so
# `minimal --nc` alone would emit `define("id",[],...)` everywhere - loadable,
# but no longer what npm ships. src/ace/*.js (our own ace modules) carry the
# __ssAce.define/__ssAce.require names in their source already.
if [ -f lib/ace/.version ] && [ "$(cat lib/ace/.version)" = "$ACE_VERSION-$ACE_NAMESPACE" ]; then
  echo "== lib/ace already at $ACE_VERSION ($ACE_NAMESPACE) - skipping ace build"
else
  ACE_SRC=$ROOT/.ace-build

  echo "== Building ace $ACE_VERSION with the module registry renamed to window.$ACE_NAMESPACE"
  mkdir -p "$(dirname "$ACE_SRC")"
  [ -d "$ACE_SRC/.git" ] || git clone -q "$ACE_REPO" "$ACE_SRC"
  git -C "$ACE_SRC" fetch -q origin tag "$ACE_VERSION" 2>/dev/null || git -C "$ACE_SRC" fetch -q origin
  git -C "$ACE_SRC" checkout -qf "$ACE_VERSION"
  git -C "$ACE_SRC" reset -q --hard "$ACE_VERSION" # drops the previous patch
  git -C "$ACE_SRC" apply "$ROOT/tools/ace-namespace.patch"
  (
    cd "$ACE_SRC"
    npm install --silent --no-audit --no-fund --ignore-scripts
    rm -rf build
    ACE_NS=$ACE_NAMESPACE node Makefile.dryice.js normal --target ./build >/dev/null
  )

  rm -rf lib/ace
  mkdir -p lib/ace
  # Just the build and its types. The npm package's top-level ace.d.ts and
  # esm-/webpack-resolver.js are sugar for bundler consumers, nothing here
  # loads them, and the build emits them by scanning src-noconflict while the
  # other variants are still writing it, so their contents vary run to run.
  cp -r "$ACE_SRC/build/src-noconflict" "$ACE_SRC/build/types" lib/ace/
  echo "$ACE_VERSION-$ACE_NAMESPACE" > lib/ace/.version

  # Chrome Web Store review reads shipped source as if it ran: ace's html/liquid
  # snippet files carry `html5shiv` snippets whose BODY TEXT is a
  # <script src="https://cdnjs.cloudflare.com/..."> tag, and the MV3 scanner
  # flags that as remotely hosted code (rejection "Blue Argon", 2026-08). They
  # are inert text for snippet insertion, and neither mode is reachable from a
  # SAS editor - drop any snippet file that embeds a remote script tag.
  grep -rlE 'script[^>]*src=[^>]*http' lib/ace/src-noconflict/snippets | xargs -r rm -f

  # The build's own sanity check already required every file under the new
  # namespace, so this only guards against copying the wrong target dir.
  grep -qrF -- "$ACE_NAMESPACE.define(" lib/ace/src-noconflict || {
    echo "tools/build_lib.sh: lib/ace is not namespaced - '$ACE_NAMESPACE.define(' not found" >&2
    exit 1
  }
fi

# -- lib/ace-linters ----------------------------------------------------------
echo "== Vendoring ace-linters@$ACE_LINTERS_VERSION"
npm pack --silent "ace-linters@$ACE_LINTERS_VERSION" --pack-destination "$TMP" >/dev/null
tar -xzf "$TMP"/ace-linters-*.tgz -C "$TMP"
rm -rf lib/ace-linters
mkdir -p lib/ace-linters
cp "$TMP/package/build/language-client.js" lib/ace-linters/
# Same MV3 remote-code rule as the ace snippets above: ace-linters' built-in
# service table gives its python service a `cdnUrl` on unpkg.com. We never
# instantiate those services (we drive our own SAS server worker), so blank the
# URL out - the only edit made to either bundle, otherwise byte-identical.
sed 's#"https://www.unpkg.com/ace-python-ruff-linter/build"#""#' \
  "$TMP/package/build/ace-language-client.js" > lib/ace-linters/ace-language-client.js
if grep -q 'unpkg.com' lib/ace-linters/ace-language-client.js; then
  echo "tools/build_lib.sh: ace-linters still references unpkg.com" >&2
  exit 1
fi

# -- lib/sas-lsp --------------------------------------------------------------
if [ -f lib/sas-lsp/sas-server.js ] && [ "$(cat lib/sas-lsp/.version 2>/dev/null)" = "$SAS_LSP_VERSION" ]; then
  echo "== lib/sas-lsp/sas-server.js already at $SAS_LSP_VERSION - skipping LSP build"
else
  BUILD_DIR=${BUILD_DIR:-$ROOT/.lsp-build}
  SRC="$BUILD_DIR/vscode-sas-extension"

  echo "== Building SAS language server $SAS_LSP_VERSION"
  mkdir -p "$BUILD_DIR"
  [ -d "$SRC/.git" ] || git clone "$SAS_LSP_REPO" "$SRC"
  git -C "$SRC" fetch -q origin tag "$SAS_LSP_VERSION" 2>/dev/null || git -C "$SRC" fetch -q origin
  # Drop any previous patch application (tracked edits + the added stub file)
  git -C "$SRC" checkout -qf "$SAS_LSP_VERSION"
  git -C "$SRC" reset -q --hard "$SAS_LSP_VERSION"
  git -C "$SRC" clean -qfd server/src
  git -C "$SRC" apply "$ROOT/tools/remove-pyright.patch"

  # compile populates server/dist/node/typeshed-fallback, which the browser
  # webpack build depends on; compile-browser alone fails without it.
  # Cap node's heap: webpack's production build otherwise balloons past what
  # small boxes have and gets OOM-killed (observed on a 4 GB host).
  (
    cd "$SRC"
    npm ci
    export NODE_OPTIONS="--max-old-space-size=2560"
    npm run compile
    npm run compile-browser
  )

  mkdir -p lib/sas-lsp
  # Don't ship the 22 MB source map; drop the reference to it too so devtools
  # doesn't log a 404.
  sed '/^\/\/# sourceMappingURL=/d' "$SRC/server/dist/browser/server.js" > lib/sas-lsp/sas-server.js
  cp "$SRC/LICENSE" lib/sas-lsp/LICENSE-sas-lsp
  echo "$SAS_LSP_VERSION" > lib/sas-lsp/.version
fi

echo "== Done: ace@$ACE_VERSION ace-linters@$ACE_LINTERS_VERSION sas-lsp@$SAS_LSP_VERSION"
