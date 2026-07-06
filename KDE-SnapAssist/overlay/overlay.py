#!/usr/bin/env python3
"""SnapAssist overlay host.

A thin PyQt6 process that renders the picker (and later Snap Assist) as a
fullscreen LayerShell surface, and exposes a D-Bus service the KWin script
drives. The script owns all input and geometry; this process only draws.

D-Bus:  service  org.kde.snapassist   object  /Picker
  setState(json)  — replace the picker state (cards / zones / highlight / preview)
  setVisible(b)   — show / hide the overlay
The KWin script calls these with an empty interface string (verified to work).

Run standalone to preview the rendering:
    python3 overlay.py --demo
"""

import configparser
import json
import os
import sys

from PyQt6.QtCore import QObject, pyqtSlot, pyqtSignal, pyqtProperty
from PyQt6.QtGui import QGuiApplication
from PyQt6.QtQml import QQmlApplicationEngine
from PyQt6.QtDBus import QDBusConnection

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = "org.kde.snapassist"
OBJPATH = "/Picker"


def _app_dirs():
    dirs = [os.path.expanduser("~/.local/share/applications")]
    xdg = os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share")
    for d in xdg.split(":"):
        if d:
            dirs.append(os.path.join(d, "applications"))
    return dirs


_icon_cache = {}


def resolve_icon(desktop_file, cls):
    """Resolve a window to a real theme icon name by reading Icon= from its
    .desktop file (falling back to the resource class, then a generic icon).
    The window's resourceClass alone is often not a valid icon name."""
    key = (desktop_file, cls)
    if key in _icon_cache:
        return _icon_cache[key]
    name = None
    if desktop_file:
        base = desktop_file if desktop_file.endswith(".desktop") else desktop_file + ".desktop"
        for d in _app_dirs():
            path = os.path.join(d, base)
            if os.path.exists(path):
                try:
                    cp = configparser.ConfigParser(interpolation=None, strict=False)
                    cp.read(path, encoding="utf-8")
                    name = cp.get("Desktop Entry", "Icon", fallback=None)
                except Exception:
                    pass
                break
    if not name:
        name = cls or "application-x-executable"
    _icon_cache[key] = name
    return name


class Bridge(QObject):
    """State holder shared between D-Bus and QML."""

    stateChanged = pyqtSignal()
    visibleChanged = pyqtSignal()
    assistChanged = pyqtSignal()
    assistVisibleChanged = pyqtSignal()

    def __init__(self):
        super().__init__()
        self._state = "{}"
        self._visible = False
        self._assist = "{}"
        self._assist_visible = False
        self._pick = ""      # pending pick, consumed by pollPick()

    # --- properties QML binds to ---
    def _get_state(self):
        return self._state

    def _get_visible(self):
        return self._visible

    def _get_assist(self):
        return self._assist

    def _get_assist_visible(self):
        return self._assist_visible

    stateJson = pyqtProperty(str, _get_state, notify=stateChanged)
    overlayVisible = pyqtProperty(bool, _get_visible, notify=visibleChanged)
    assistJson = pyqtProperty(str, _get_assist, notify=assistChanged)
    assistVisible = pyqtProperty(bool, _get_assist_visible, notify=assistVisibleChanged)

    # --- picker slots (D-Bus + in-process) ---
    @pyqtSlot(str)
    def setState(self, s):
        self._state = s or "{}"
        self.stateChanged.emit()

    @pyqtSlot(bool)
    def setVisible(self, v):
        v = bool(v)
        if v != self._visible:
            self._visible = v
            self.visibleChanged.emit()

    # --- assist slots ---
    @pyqtSlot(str)
    def setAssist(self, s):
        # Resolve each candidate's icon from its .desktop file before handing to
        # QML (the script sends desktopFile + cls; QML reads candidate.icon).
        try:
            data = json.loads(s or "{}")
            for c in data.get("candidates", []):
                c["icon"] = resolve_icon(c.get("desktopFile", ""), c.get("cls", ""))
            s = json.dumps(data)
        except Exception:
            pass
        self._assist = s or "{}"
        self._pick = ""          # fresh round
        self.assistChanged.emit()

    @pyqtSlot(bool)
    def setAssistVisible(self, v):
        v = bool(v)
        if v != self._assist_visible:
            self._assist_visible = v
            if not v:
                self._pick = ""
            self.assistVisibleChanged.emit()

    # Called by the KWin script (polling) to fetch and clear the last pick.
    # Returns "" if nothing yet, else JSON {"slot":n,"idx":m} or {"cancel":true}.
    @pyqtSlot(result=str)
    def pollPick(self):
        p = self._pick
        self._pick = ""
        return p

    # Called from QML on click.
    @pyqtSlot(int, int)
    def reportPick(self, slot, idx):
        self._pick = json.dumps({"slot": slot, "idx": idx})

    @pyqtSlot()
    def reportCancel(self):
        self._pick = json.dumps({"cancel": True})

    @pyqtSlot(result=str)
    def ping(self):
        return "snapassist-overlay"


# ---------------------------------------------------------------------------
# Demo state builder (mirrors the card layout the KWin script produces).
# Only used by --demo; production state arrives over D-Bus.
# ---------------------------------------------------------------------------
DEMO_TEMPLATES = [
    ("Halves", [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]),
    ("Top / bottom", [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]),
    ("Thirds", [[0, 0, 1/3, 1], [1/3, 0, 1/3, 1], [2/3, 0, 1/3, 1]]),
    ("Wide + side", [[0, 0, 0.7, 1], [0.7, 0, 0.3, 1]]),
    ("Quarters", [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]]),
    ("Main + stack", [[0, 0, .6, 1], [.6, 0, .4, .5], [.6, .5, .4, .5]]),
]


def build_demo_state(sw, sh):
    work = (0, 0, sw, sh)
    wx, wy, ww, wh = work
    card_h, card_gap, top_margin, gap = 150, 20, 24, 8
    card_w = card_h * (ww / wh)
    n = len(DEMO_TEMPLATES)
    total = n * card_w + (n - 1) * card_gap
    start_x = (sw - total) / 2
    top = wy + top_margin

    cards, zones = [], []
    for ci, (name, tzones) in enumerate(DEMO_TEMPLATES):
        cx = start_x + ci * (card_w + card_gap)
        cards.append({"name": name, "rect": [cx, top, card_w, card_h]})
        for zi, (fx, fy, fw, fh) in enumerate(tzones):
            zones.append({"c": ci, "z": zi, "rect": [
                cx + fx * card_w + 1, top + fy * card_h + 1,
                fw * card_w - 2, fh * card_h - 2]})
    # highlight the left half of "Halves" and preview where it would land
    highlight = {"c": 0, "z": 0}
    preview = [wx + gap / 2, wy + gap / 2, ww * 0.5 - gap, wh - gap]
    return {"cards": cards, "zones": zones, "highlight": highlight, "preview": preview}


def main():
    app = QGuiApplication(sys.argv)
    bridge = Bridge()

    bus = QDBusConnection.sessionBus()
    bus.registerObject(OBJPATH, bridge,
                       QDBusConnection.RegisterOption.ExportAllSlots)
    if not bus.registerService(SERVICE):
        sys.stderr.write("snapassist: could not take D-Bus name %s "
                         "(already running?)\n" % SERVICE)

    engines = []
    for qml in ("Picker.qml", "Assist.qml"):
        eng = QQmlApplicationEngine()
        eng.rootContext().setContextProperty("bridge", bridge)
        eng.load(os.path.join(HERE, qml))
        if not eng.rootObjects():
            sys.stderr.write("snapassist: failed to load %s\n" % qml)
            return 2
        engines.append(eng)

    if "--demo" in sys.argv:
        scr = app.primaryScreen().geometry()
        bridge.setState(json.dumps(build_demo_state(scr.width(), scr.height())))
        bridge.setVisible(True)

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
