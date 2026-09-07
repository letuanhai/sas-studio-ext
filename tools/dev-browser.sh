#!/bin/sh
# Launch a CDP-debuggable Chromium with this extension loaded unpacked, so
# nothing has to be installed or reloaded through chrome://extensions.
#
#   ./tools/dev-browser.sh                 # headless unless DISPLAY is set
#   ./tools/dev-browser.sh stop            # kill it
#
# The port is reachable only over an ssh tunnel, by design and by Chrome's:
# --remote-debugging-address is accepted and then silently IGNORED, so the
# debug port is always on 127.0.0.1 (measured on 151/153 - `ss -ltn` shows
# 127.0.0.1 with =0.0.0.0 and with an explicit interface address alike).
#   ssh -N -L 9222:localhost:9222 user@host
# Then open http://localhost:9222 on the client. Keep "localhost" in that url:
# the DevTools endpoint answers "Host header is specified and is not an IP
# address or localhost" to anything else.
#   PORT=9333 ./tools/dev-browser.sh       # another port
#   CLEAN=1 ./tools/dev-browser.sh         # also drop the extension's settings
#   URL= ./tools/dev-browser.sh            # don't open SAS Studio at startup
#   ./tools/dev-browser.sh --headless=new  # extra flags pass through
#
# Re-running this IS the reload: it kills the previous instance and starts a
# fresh one. Deliberately not chrome.runtime.reload() over CDP - under
# --load-extension that unloads the extension permanently (no service-worker
# target, every extension page ERR_BLOCKED_BY_CLIENT) until Chrome restarts.
#
# Most edits do NOT need this at all - just reload the SAS Studio page. What a
# page reload already picks up: everything sw.js file-injects (ss-fixes.js,
# tools-meta.js, editor-swap.js, ace-patches.js), every page-fetched resource
# (src/ace/*.js, src/lua/*.lua, lib/*, src/dark.css) and the extension's own
# pages (options/popup/changelog). What needs this script re-run: manifest.json,
# src/relay.js and any other declared content script, the dark-inject.js /
# dark-media-auto.js pair registered via chrome.scripting, and src/sw.js.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-9222}
DATA=${DATA:-/tmp/ssext-chrome}
PIDFILE=$DATA/.launcher.pid

# Kill by pid, not `pkill -f`: the pattern would match this script's own cmdline.
stop() {
	[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
	rm -f "$PIDFILE"
}

[ "$1" = "stop" ] && { stop; echo "stopped"; exit 0; }

# Playwright's build, not /usr/bin/google-chrome: stable Chrome silently
# ignores --load-extension in headless (checked on 151, including with
# --disable-features=DisableLoadExtensionCommandLineSwitch).
CHROME=${CHROME_BIN:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}
[ -x "$CHROME" ] || { echo "no playwright chromium - run: npx playwright install chromium" >&2; exit 1; }

mkdir -p "$DATA"
stop
sleep 1

# Wipe the profile, because a restart alone does NOT reload src/sw.js: Chrome
# caches the extension's service-worker script in the user-data-dir and reuses
# it across browser restarts even when the file changed AND the manifest
# version was bumped (measured - manifest 1.1 live, old sw.js body still
# running). Everything else refreshes without this; the service worker only
# comes back from a clean profile. The extension id is derived from the source
# path, so it survives the wipe.
#
# The one thing worth keeping across it is the extension's own settings, which
# live in ONE leveldb directory per extension id, so carry that over rather
# than keeping the whole profile (which would bring the stale service worker
# with it). Chrome flushes it on exit, and `stop` above already waited, so
# what is on disk now is current. CLEAN=1 drops it too, for a true first-run.
SETTINGS="Default/Local Extension Settings"
STASH=$(mktemp -d)
if [ -z "$CLEAN" ] && [ -d "$DATA/$SETTINGS" ]; then
	cp -a "$DATA/$SETTINGS" "$STASH/settings"
fi
rm -rf "$DATA"
mkdir -p "$DATA/Default"
if [ -d "$STASH/settings" ]; then
	mv "$STASH/settings" "$DATA/$SETTINGS"
	echo "config: carried over (CLEAN=1 to reset)"
fi
rm -rf "$STASH"

if [ -n "$DISPLAY" ]; then
	MODE="headed on DISPLAY=$DISPLAY"
else
	set -- --headless=new "$@"
	MODE="headless (no DISPLAY)"
	# Loud, because the fallback is silent otherwise and the symptom is just
	# "no window appeared" - which is what an ssh session that dropped X11
	# forwarding looks like too. Reconnect with -Y and check with xdpyinfo.
	echo "warning: no DISPLAY, running headless - no window will appear." >&2
	echo "         for a window: ssh -Y -C <host>, verify with 'xdpyinfo | head -3', re-run here." >&2
fi

# --remote-allow-origins is what makes the DevTools frontend usable from a
# browser at all: since Chrome 111 a /devtools/page/<id> websocket handshake
# carrying ANY Origin header is answered 403 (measured - the same handshake
# without the header gets 101), and a frontend page served over http always
# sends one. Tools that speak CDP directly (playwright, curl) send none, which
# is why they work without it.
# Opens SAS Studio, since that is the only page this extension does anything
# on. `URL=` (empty) starts on the new-tab page instead, `URL=...` elsewhere -
# hence ${URL-default} rather than ${URL:-default}, so an empty value is a
# deliberate choice and not a fallback to the default.
# Note each load of the app creates a workspace session on the server, and its
# own cleanup is dead code (see the session-leak note above), so this leaks one
# per launch until the server times it out.
URL=${URL-https://sas.lth0.net/SASStudio/38/}

"$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$DATA" \
	--remote-allow-origins="http://localhost:$PORT" \
	--no-first-run --no-default-browser-check \
	--load-extension="$ROOT" "$@" ${URL:+"$URL"} >"$DATA/chrome.log" 2>&1 &
echo $! >"$PIDFILE"

i=0
while [ $i -lt 60 ]; do
	ID=$(curl -s "http://localhost:$PORT/json/list" 2>/dev/null |
		sed -n 's|.*chrome-extension://\([a-p]*\)/src/sw\.js.*|\1|p' | head -1)
	[ -n "$ID" ] && break
	i=$((i + 1))
	sleep 0.5
done

if [ -z "$ID" ]; then
	# A dead X connection lands here too, and "extension did not load" is a
	# misleading way to say it, so name the real cause when the log shows it.
	if grep -q "Missing X server" "$DATA/chrome.log" 2>/dev/null; then
		echo "DISPLAY=$DISPLAY is set but unreachable - chrome could not open it." >&2
		echo "check with 'xdpyinfo | head -3'; if that fails, reconnect with ssh -Y" >&2
		echo "(and on the client: install xauth, keep the X server app foregrounded)." >&2
	else
		echo "extension did not load - see $DATA/chrome.log" >&2
	fi
	exit 1
fi

# The bare http://localhost:$PORT/ is a 200 with Content-Length 0 - a genuinely
# blank page, not a broken tunnel. The frontend lives at /devtools/inspector.html
# and needs the ws= of a specific target; /json/list's own devtoolsFrontendUrl
# points at the appspot.com-hosted copy instead, which a phone behind an ssh
# tunnel cannot use. So print a ready-to-open link to the LOCAL frontend.
PAGE=$(curl -s "http://localhost:$PORT/json/list" |
	tr ',' '\n' | sed -n 's|.*"id": "\([A-F0-9]\{20,\}\)".*|\1|p' | head -1)

echo "mode:     $MODE"
echo "cdp:      http://localhost:$PORT   (tunnel: ssh -N -L $PORT:localhost:$PORT $(whoami)@$(hostname))"
echo "devtools: http://localhost:$PORT/devtools/inspector.html?ws=localhost:$PORT/devtools/page/$PAGE"
echo "ext:      chrome-extension://$ID  (options: /src/options.html, popup: /src/popup.html)"
echo "stop:     ./tools/dev-browser.sh stop"
