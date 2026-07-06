// Snap Assist overlay — after a window is snapped, this fills the layout's
// still-empty tiles with the icons of the other open windows. Clicking an icon
// reports (slot, candidate index) back to the KWin script via the bridge; the
// script does the actual `window.tile =` assignment.
//
// State (bridge.assistJson):
//   { "slots":     [ {"rect":[x,y,w,h]}, ... ],           // empty tiles, screen px
//     "candidates":[ {"idx":n,"caption":"…","icon":"…"} ] } // windows to offer

import QtQuick
import org.kde.layershell as LayerShell
import org.kde.kirigami as Kirigami

Window {
    id: root
    visible: bridge.assistVisible
    color: "transparent"
    flags: Qt.FramelessWindowHint

    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom
                             | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityOnDemand

    property var a: ({})
    function reparse() {
        try { a = JSON.parse(bridge.assistJson || "{}") }
        catch (e) { console.log("[snapassist] bad assist json:", e); a = {} }
    }
    Connections { target: bridge; function onAssistChanged() { root.reparse() } }
    Component.onCompleted: reparse()

    readonly property color accent: Kirigami.Theme.highlightColor
    readonly property color panelBg: Qt.rgba(Kirigami.Theme.backgroundColor.r,
                                             Kirigami.Theme.backgroundColor.g,
                                             Kirigami.Theme.backgroundColor.b, 0.96)
    readonly property color textCol: Kirigami.Theme.textColor

    // dim + click-to-dismiss backdrop
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, 0.35)
        MouseArea { anchors.fill: parent; onClicked: bridge.reportCancel() }
    }
    Shortcut { sequence: "Escape"; onActivated: bridge.reportCancel() }

    // one panel per empty tile, each showing every candidate window
    Repeater {
        model: root.a.slots || []
        delegate: Rectangle {
            required property var modelData
            required property int index
            readonly property int slotIndex: index
            x: modelData.rect[0]; y: modelData.rect[1]
            width: modelData.rect[2]; height: modelData.rect[3]
            radius: 10
            color: root.panelBg
            border.color: root.accent
            border.width: 2

            // Grid sizes to its own content, so centerIn genuinely centers the
            // icons in the tile (a fixed-width Flow left-aligned them).
            Grid {
                anchors.centerIn: parent
                readonly property int count: (root.a.candidates || []).length
                columns: Math.max(1, Math.min(count,
                         Math.floor((parent.width - 24) / 112)))
                rowSpacing: 16
                columnSpacing: 16
                horizontalItemAlignment: Grid.AlignHCenter
                verticalItemAlignment: Grid.AlignVCenter
                Repeater {
                    model: root.a.candidates || []
                    // Plain Item (not Column/Layout) so children may use anchors.
                    delegate: Item {
                        required property var modelData
                        width: 96
                        height: 94
                        Kirigami.Icon {
                            width: 64; height: 64
                            anchors.horizontalCenter: parent.horizontalCenter
                            anchors.top: parent.top
                            source: modelData.icon || "application-x-executable"
                        }
                        Text {
                            anchors.top: parent.top
                            anchors.topMargin: 68
                            width: parent.width
                            text: modelData.caption || ""
                            color: root.textCol
                            font.pixelSize: 11
                            elide: Text.ElideRight
                            maximumLineCount: 1
                            horizontalAlignment: Text.AlignHCenter
                        }
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: bridge.reportPick(slotIndex, modelData.idx)
                        }
                    }
                }
            }
        }
    }
}
