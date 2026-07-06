#!/usr/bin/env bash
# Dev helper: install the KWin script, start the overlay process, and reload
# KWin — no logout needed.
#   ./dev-install.sh          install script + (re)start overlay + reload KWin
#   ./dev-install.sh --watch  follow the [snapassist] journal + overlay stdout
#   ./dev-install.sh --stop    stop the overlay and unload the script
# (no `set -e`: several steps return non-zero benignly, e.g. pkill/reconfigure)
set -uo pipefail

ID="kde-snapassist"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/kwin/scripts/$ID"
OVERLAY="$SRC/overlay/overlay.py"
OVLOG="/tmp/snapassist-overlay.log"
OVPID="/tmp/snapassist-overlay.pid"

stop_overlay() {  # kill by recorded PID (never pkill -f: the pattern would
                  # match this very shell's command line and kill it)
    [ -f "$OVPID" ] && kill "$(cat "$OVPID")" 2>/dev/null || true
    rm -f "$OVPID"
}

case "${1:-}" in
--watch)
    tail -f "$OVLOG" 2>/dev/null &
    journalctl --user _COMM=kwin_wayland -f 2>/dev/null | grep --line-buffered "\[snapassist\]"
    ;;
--stop)
    stop_overlay
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$ID" >/dev/null 2>&1 || true
    echo "stopped overlay + unloaded script"
    ;;
*)
    echo "Installing KWin script -> $DEST"
    rm -rf "$DEST"; mkdir -p "$DEST"
    cp -r "$SRC/metadata.json" "$SRC/contents" "$DEST/"

    echo "Restarting overlay ($OVERLAY)"
    stop_overlay
    sleep 0.3
    setsid python3 "$OVERLAY" >"$OVLOG" 2>&1 < /dev/null &
    echo $! > "$OVPID"
    sleep 0.7

    echo "Reloading KWin script"
    kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$ID" >/dev/null 2>&1 || true
    qdbus6 org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true

    echo "Done. Drag a window to the TOP edge to open the picker."
    echo "Logs:  $0 --watch"
    ;;
esac
