// SnapAssist picker overlay — a purely presentational fullscreen LayerShell
// surface. All geometry is computed by the KWin script and pushed here as JSON
// over D-Bus (see overlay.py / main.js). We just draw what we're told:
//   - a full-screen preview of where the window will land (state.preview)
//   - a row of template cards (state.cards: name + bounding rect)
//   - the zones of every card (state.zones: absolute screen rects), with the
//     hovered zone highlighted (state.highlight)
//
// Coordinates are absolute screen pixels; the surface fills the screen, so an
// item's x/y map 1:1 to screen position.

import QtQuick
import QtQuick.Window
import org.kde.layershell as LayerShell
import org.kde.kirigami as Kirigami

Window {
    id: root
    visible: bridge.overlayVisible
    color: "transparent"
    flags: Qt.FramelessWindowHint

    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom
                             | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    // Parsed picker state, re-parsed whenever the bridge signals a change.
    property var st: ({})
    function reparse() {
        try { st = JSON.parse(bridge.stateJson || "{}") }
        catch (e) { console.log("[snapassist] bad state json:", e); st = {} }
    }
    Connections {
        target: bridge
        function onStateChanged() { root.reparse() }
    }
    Component.onCompleted: reparse()

    // Theme-derived palette (follows Plasma accent + light/dark live).
    readonly property color accent: Kirigami.Theme.highlightColor
    readonly property color panelBg: Qt.rgba(Kirigami.Theme.backgroundColor.r,
                                             Kirigami.Theme.backgroundColor.g,
                                             Kirigami.Theme.backgroundColor.b, 0.95)
    readonly property color textCol: Kirigami.Theme.textColor
    readonly property color zoneBg: Qt.rgba(textCol.r, textCol.g, textCol.b, 0.16)
    readonly property color zoneBorder: Qt.rgba(textCol.r, textCol.g, textCol.b, 0.34)
    readonly property color cardBg: Qt.rgba(textCol.r, textCol.g, textCol.b, 0.10)

    // Bounding box of all cards (+ padding and room for the labels) — used to
    // draw a solid theme-colored panel behind the row so the thumbnails read
    // against any wallpaper.
    readonly property var panelRect: {
        var cs = st.cards || []
        if (cs.length === 0) return null
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (var i = 0; i < cs.length; i++) {
            var r = cs[i].rect
            x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1])
            x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3])
        }
        var pad = 18, labelH = 22
        return [x0 - pad, y0 - pad, (x1 - x0) + 2 * pad, (y1 - y0) + 2 * pad + labelH]
    }

    // 1) Full-screen preview of exactly where the window will land.
    Rectangle {
        id: preview
        property var r: root.st.preview || null
        visible: r !== null
        x: r ? r[0] : 0;  y: r ? r[1] : 0
        width: r ? r[2] : 0;  height: r ? r[3] : 0
        radius: 10
        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.28)
        border.color: root.accent
        border.width: 3
    }

    // 2) Solid panel behind the whole card row (theme-colored, opaque enough to
    // read on any wallpaper).
    Rectangle {
        visible: root.panelRect !== null
        x: root.panelRect ? root.panelRect[0] : 0
        y: root.panelRect ? root.panelRect[1] : 0
        width: root.panelRect ? root.panelRect[2] : 0
        height: root.panelRect ? root.panelRect[3] : 0
        radius: 16
        color: root.panelBg
        border.color: Qt.rgba(root.textCol.r, root.textCol.g, root.textCol.b, 0.15)
        border.width: 1
    }

    // 3) Card panels (name + bounding box behind the zones).
    Repeater {
        model: root.st.cards || []
        delegate: Item {
            required property var modelData
            Rectangle {
                x: modelData.rect[0]; y: modelData.rect[1]
                width: modelData.rect[2]; height: modelData.rect[3]
                radius: 8
                color: root.cardBg
            }
            Text {
                text: modelData.name || ""
                color: root.textCol
                font.pixelSize: 13
                x: modelData.rect[0] + (modelData.rect[2] - width) / 2
                y: modelData.rect[1] + modelData.rect[3] + 4
            }
        }
    }

    // 3) Zones (drawn on top), hovered one highlighted.
    Repeater {
        model: root.st.zones || []
        delegate: Rectangle {
            required property var modelData
            readonly property bool hot: root.st.highlight
                && root.st.highlight.c === modelData.c
                && root.st.highlight.z === modelData.z
            x: modelData.rect[0]; y: modelData.rect[1]
            width: modelData.rect[2]; height: modelData.rect[3]
            radius: 4
            color: hot ? root.accent : root.zoneBg
            border.color: hot ? Qt.rgba(1, 1, 1, 0.9) : root.zoneBorder
            border.width: hot ? 1.5 : 1
        }
    }

    // Click-to-dismiss. During a real drag the compositor owns the pointer
    // (move grab), so this never fires; it only catches clicks when the picker
    // is left stuck (a drag interrupted without a finish event). Reports cancel
    // to the script, which then hides + resets state.
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onClicked: bridge.reportCancel()
    }
}
