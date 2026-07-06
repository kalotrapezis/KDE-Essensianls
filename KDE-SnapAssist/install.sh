#!/usr/bin/env bash
# KDE Snap Assist — per-user installer.
#
#   ./install.sh              install (KWin script + overlay + login autostart)
#   ./install.sh --uninstall  remove everything this installed
#
# Installs into the user's home (no root needed):
#   ~/.local/share/kwin/scripts/kde-snapassist   the KWin script
#   ~/.local/share/kde-snapassist/overlay        the overlay app
#   ~/.config/autostart/kde-snapassist.desktop   starts the overlay at login
set -uo pipefail

ID="kde-snapassist"
SVC="org.kde.snapassist"
SRC="$(cd "$(dirname "$0")" && pwd)"
KWIN_DIR="$HOME/.local/share/kwin/scripts/$ID"
APP_DIR="$HOME/.local/share/$ID"
AUTOSTART="$HOME/.config/autostart/$ID.desktop"
OVERLAY="$APP_DIR/overlay/overlay.py"

overlay_pid() { qdbus6 org.freedesktop.DBus / \
    org.freedesktop.DBus.GetConnectionUnixProcessID "$SVC" 2>/dev/null; }

stop_overlay() { local p; p="$(overlay_pid)"; [ -n "$p" ] && kill "$p" 2>/dev/null || true; }

reload_kwin() {
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$ID" >/dev/null 2>&1 || true
    qdbus6 org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
    stop_overlay
    kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false >/dev/null 2>&1
    reload_kwin
    rm -rf "$KWIN_DIR" "$APP_DIR" "$AUTOSTART"
    echo "KDE Snap Assist uninstalled."
    exit 0
fi

# --- dependency check (warn, don't block) ---
miss=0
python3 -c "import PyQt6.QtQml" 2>/dev/null || { echo "! missing: python3-pyqt6"; miss=1; }
[ -d /usr/lib/*/qt6/qml/org/kde/layershell ] 2>/dev/null || \
    ls -d /usr/lib/*/qt6/qml/org/kde/layershell >/dev/null 2>&1 || \
    { echo "! missing: qml6-module-org-kde-layershell (LayerShellQt)"; miss=1; }
if [ "$miss" = 1 ]; then
    echo "  Install with:  sudo apt install python3-pyqt6 qml6-module-org-kde-layershell"
    echo "  Continuing anyway..."
fi

echo "Installing KWin script -> $KWIN_DIR"
rm -rf "$KWIN_DIR"; mkdir -p "$KWIN_DIR"
cp -r "$SRC/metadata.json" "$SRC/contents" "$KWIN_DIR/"

echo "Installing overlay -> $APP_DIR/overlay"
rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
cp -r "$SRC/overlay" "$APP_DIR/"

echo "Installing login autostart -> $AUTOSTART"
mkdir -p "$(dirname "$AUTOSTART")"
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=KDE Snap Assist
Comment=Windows 11-style snap layouts and Snap Assist overlay
Exec=python3 $OVERLAY
OnlyShowIn=KDE;
X-KDE-autostart-phase=2
NoDisplay=true
EOF

echo "Enabling + starting"
kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true >/dev/null 2>&1
stop_overlay; sleep 0.3
setsid python3 "$OVERLAY" >/tmp/snapassist-overlay.log 2>&1 < /dev/null &
sleep 0.6
reload_kwin

echo
echo "Done. Drag a window to the TOP edge to open the snap picker."
echo "It will start automatically on your next login."
