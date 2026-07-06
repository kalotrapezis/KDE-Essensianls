/*
 * KDE Snap Assist — Windows 11-style snap layouts on top of KWin's own tiling.
 *
 * This resident KWin script is input + logic; it can't draw (the script engine
 * has no QML), so it drives a companion overlay process (overlay/overlay.py)
 * over D-Bus. When the user drags a window to the top edge we show the picker;
 * the script feeds it the pointer-driven highlight + preview each move step; on
 * release we reshape the screen's live tile tree to the chosen template and hand
 * the window to KWin with `window.tile = <leaf tile>`.
 *
 * Everything here is verified against the KWin 6.6 scripting API on-device
 * (see README for the recipe): tile split()/remove()/resizeByPixels(delta,edge),
 * window.tile assignment, callDBus with an empty interface + reply callback.
 */

"use strict";

var DIR = { FLOATING: 0, HORIZONTAL: 1, VERTICAL: 2 };
var EDGE = { TOP: 1, LEFT: 2, RIGHT: 4, BOTTOM: 8 };

var SVC = "org.kde.snapassist";
var OBJ = "/Picker";

var CFG = {
    gap: 8,          // px around/between snapped windows (for the preview only)
    trigger_px: 14,  // how close to the top edge opens the picker
    card_height: 150,
    card_gap: 20,
    top_margin: 24
};

function log() {
    var s = "";
    for (var i = 0; i < arguments.length; i++) s += arguments[i] + " ";
    print("[snapassist] " + s);
}

/* Templates as guillotine trees (leaf = {weight}, container = {dir, children}).
 * Mirror 11snap's 5 defaults; all map 1:1 onto KWin tile trees. */
var TEMPLATES = [
    { name: "Halves", root: { dir: DIR.HORIZONTAL, children: [{ weight: 0.5 }, { weight: 0.5 }] } },
    { name: "Top / bottom", root: { dir: DIR.VERTICAL, children: [{ weight: 0.5 }, { weight: 0.5 }] } },
    { name: "Thirds", root: { dir: DIR.HORIZONTAL, children: [{ weight: 1/3 }, { weight: 1/3 }, { weight: 1/3 }] } },
    { name: "Wide + side", root: { dir: DIR.HORIZONTAL, children: [{ weight: 0.7 }, { weight: 0.3 }] } },
    { name: "Quarters", root: { dir: DIR.HORIZONTAL, children: [
        { weight: 0.5, dir: DIR.VERTICAL, children: [{ weight: 0.5 }, { weight: 0.5 }] },
        { weight: 0.5, dir: DIR.VERTICAL, children: [{ weight: 0.5 }, { weight: 0.5 }] }] } },
    { name: "Main + stack", root: { dir: DIR.HORIZONTAL, children: [
        { weight: 0.6 },
        { weight: 0.4, dir: DIR.VERTICAL, children: [{ weight: 0.5 }, { weight: 0.5 }] }] } }
];

// ---------------------------------------------------------------------------
// Template geometry (leaf fraction-rects, in the SAME DFS order that
// buildNode() creates tiles and collectLeaves() reads them back — so zone index
// z maps directly to leaf tile z).
// ---------------------------------------------------------------------------
function templateGeometry(node, box) {
    box = box || [0, 0, 1, 1];
    if (!node.children || node.children.length === 0) return [box];
    var horiz = node.dir === DIR.HORIZONTAL;
    var total = 0, i;
    for (i = 0; i < node.children.length; i++) total += node.children[i].weight;
    var out = [], acc = 0;
    for (i = 0; i < node.children.length; i++) {
        var frac = node.children[i].weight / total;
        var cbox = horiz
            ? [box[0] + acc * box[2], box[1], frac * box[2], box[3]]
            : [box[0], box[1] + acc * box[3], box[2], frac * box[3]];
        out = out.concat(templateGeometry(node.children[i], cbox));
        acc += frac;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Live tile-tree reshaping (verified recipe — see README).
// ---------------------------------------------------------------------------
function flatten(tile) {
    var guard = 0;
    while (tile.tiles && tile.tiles.length > 0 && guard++ < 64) {
        tile.tiles[tile.tiles.length - 1].remove();
    }
}

function buildNode(tile, node) {
    if (!node.children || node.children.length === 0) return;
    var count = node.children.length, s, i;
    tile.split(node.dir);
    for (s = 2; s < count; s++) tile.tiles[tile.tiles.length - 1].split(node.dir);
    setWeights(tile, node);
    for (i = 0; i < count && i < tile.tiles.length; i++) buildNode(tile.tiles[i], node.children[i]);
}

function setWeights(tile, node) {
    var children = tile.tiles;
    if (!children || children.length < 2) return;
    var horiz = node.dir === DIR.HORIZONTAL;
    var edge = horiz ? EDGE.RIGHT : EDGE.BOTTOM;
    var base = horiz ? tile.absoluteGeometry.x : tile.absoluteGeometry.y;
    var full = horiz ? tile.absoluteGeometry.width : tile.absoluteGeometry.height;
    var total = 0, i;
    for (i = 0; i < node.children.length; i++) total += node.children[i].weight;
    var acc = 0;
    for (var b = 0; b < children.length - 1; b++) {
        acc += node.children[b].weight / total;
        var targetEdge = base + Math.round(full * acc);
        var cur = children[b].absoluteGeometry;
        var curEdge = horiz ? (cur.x + cur.width) : (cur.y + cur.height);
        var delta = Math.round(targetEdge - curEdge);
        if (delta !== 0) children[b].resizeByPixels(delta, edge);
    }
}

function collectLeaves(tile, out) {
    out = out || [];
    if (!tile.tiles || tile.tiles.length === 0) { out.push(tile); return out; }
    for (var i = 0; i < tile.tiles.length; i++) collectLeaves(tile.tiles[i], out);
    return out;
}

function applyTemplate(tm, template) {
    flatten(tm.rootTile);
    buildNode(tm.rootTile, template.root);
}

/* True if the screen's current tile tree already matches `template` (within a
 * small tolerance). Used to AVOID re-flattening — flatten() removes tiles, and
 * removing a tile that holds a window un-tiles it (snapping it back to its old
 * geometry). So when filling another zone of a layout that's already in place
 * (the Snap Assist case, and re-dropping into the same layout), we must not
 * rebuild — just assign the window to its leaf. */
function treeMatches(tm, template) {
    var leaves = collectLeaves(tm.rootTile, []);
    var want = templateGeometry(template.root);
    if (leaves.length !== want.length) return false;
    var g = tm.rootTile.absoluteGeometry, eps = 0.02;
    for (var i = 0; i < leaves.length; i++) {
        var a = leaves[i].absoluteGeometry;
        var fr = [(a.x - g.x) / g.width, (a.y - g.y) / g.height,
                  a.width / g.width, a.height / g.height];
        for (var k = 0; k < 4; k++) if (Math.abs(fr[k] - want[i][k]) > eps) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Picker geometry: cards (name + bounding rect) + flat zones (screen rect +
// target work-rect). Ported from 11snap's SnapOverlay.build.
// ---------------------------------------------------------------------------
function screenWork() {
    var tm = workspace.tilingForScreen(workspace.activeScreen);
    var g = tm.rootTile.absoluteGeometry;
    return { x: g.x, y: g.y, w: g.width, h: g.height };
}

function computeCards(work) {
    var ch = CFG.card_height;
    var cw = ch * (work.w / work.h);
    var n = TEMPLATES.length;
    var total = n * cw + (n - 1) * CFG.card_gap;
    var startX = work.x + (work.w - total) / 2;
    var top = work.y + CFG.top_margin;
    var gap = CFG.gap;

    var cards = [], zones = [];
    for (var i = 0; i < n; i++) {
        var cx = startX + i * (cw + CFG.card_gap);
        cards.push({ name: TEMPLATES[i].name, rect: [cx, top, cw, ch] });
        var leaves = templateGeometry(TEMPLATES[i].root);
        for (var z = 0; z < leaves.length; z++) {
            var f = leaves[z];
            zones.push({
                c: i, z: z,
                rect: [cx + f[0] * cw + 1, top + f[1] * ch + 1, f[2] * cw - 2, f[3] * ch - 2],
                target: [Math.round(work.x + f[0] * work.w + gap / 2),
                         Math.round(work.y + f[1] * work.h + gap / 2),
                         Math.round(f[2] * work.w - gap),
                         Math.round(f[3] * work.h - gap)]
            });
        }
    }
    return { cards: cards, zones: zones };
}

function zoneAt(px, py) {
    if (!STATE.zones) return null;
    for (var i = 0; i < STATE.zones.length; i++) {
        var r = STATE.zones[i].rect;
        if (px >= r[0] && px <= r[0] + r[2] && py >= r[1] && py <= r[1] + r[3]) return STATE.zones[i];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Overlay D-Bus (empty interface — verified callable).
// ---------------------------------------------------------------------------
function ovShow(v) { callDBus(SVC, OBJ, "", "setVisible", v); }
function ovState(obj) { callDBus(SVC, OBJ, "", "setState", JSON.stringify(obj)); }
function ovAssist(obj) { callDBus(SVC, OBJ, "", "setAssist", JSON.stringify(obj)); }
function ovAssistShow(v) { callDBus(SVC, OBJ, "", "setAssistVisible", v); }
function ovPoll(cb) { callDBus(SVC, OBJ, "", "pollPick", cb); }

// ---------------------------------------------------------------------------
// Snap Assist: after a snap, fill the layout's empty tiles with the other
// windows' icons; a click (reported by the overlay, polled here) assigns one.
// ---------------------------------------------------------------------------
var assistLeaves = [];   // empty tile objects, parallel to overlay "slots"
var assistCands = [];    // candidate window objects, parallel to "candidates"
var pollT = null;

function candidateWindows() {
    var out = [], L = workspace.windowList();
    for (var i = 0; i < L.length; i++) {
        var w = L[i];
        if (!w.normalWindow) continue;                          // skip panels etc.
        if (w.tile) continue;                                   // already placed
        if (("" + w.resourceClass).indexOf("python") >= 0) continue; // our overlay
        // Minimized windows ARE offered (like Windows 11) — picking one restores
        // it into the tile. Skip windows on other virtual desktops.
        if (!w.onAllDesktops && w.desktops && w.desktops.length &&
            w.desktops.indexOf(workspace.currentDesktop) < 0) continue;
        out.push(w);
    }
    return out;
}

function sendAssist() {
    var slots = [], cands = [];
    for (var i = 0; i < assistLeaves.length; i++) {
        var g = assistLeaves[i].absoluteGeometry;
        slots.push({ rect: [g.x, g.y, g.width, g.height] });
    }
    for (var j = 0; j < assistCands.length; j++) {
        var w = assistCands[j];
        cands.push({
            idx: j,
            caption: "" + (w.caption || ""),
            desktopFile: "" + (w.desktopFileName || ""),
            cls: "" + (w.resourceClass || "")
        });
    }
    ovAssist({ slots: slots, candidates: cands });
}

function beginAssist(tm) {
    var leaves = collectLeaves(tm.rootTile, []);
    assistLeaves = [];
    for (var i = 0; i < leaves.length; i++) {
        if (!leaves[i].windows || leaves[i].windows.length === 0) assistLeaves.push(leaves[i]);
    }
    assistCands = candidateWindows();
    if (assistLeaves.length === 0 || assistCands.length === 0) return;
    sendAssist();
    ovAssistShow(true);
    startPoll();
}

function pollTick() {
    ovPoll(function (r) {
        if (!r) return;
        var o;
        try { o = JSON.parse(r); } catch (e) { return; }
        if (o.cancel) { endAssist(); return; }
        var w = assistCands[o.idx], leaf = assistLeaves[o.slot];
        if (w && leaf) {
            if (w.minimized) w.minimized = false;   // restore if it was minimized
            w.tile = leaf;
            log("assist placed", w.caption);
        }
        assistLeaves.splice(o.slot, 1);
        assistCands.splice(o.idx, 1);
        if (assistLeaves.length === 0 || assistCands.length === 0) endAssist();
        else sendAssist();
    });
}

function startPoll() {
    if (pollT) return;
    pollT = new QTimer();
    pollT.interval = 130;
    pollT.timeout.connect(pollTick);
    pollT.start();
}

function endAssist() {
    if (pollT) { pollT.stop(); pollT = null; }
    ovAssistShow(false);
    assistLeaves = [];
    assistCands = [];
}

// ---------------------------------------------------------------------------
// Drag state machine
// ---------------------------------------------------------------------------
var STATE = { cards: null, zones: null };
var dragWin = null;
var overlayShown = false;
var watchT = null;
var watchTicks = 0;

function abortPicker(reason) {
    ovShow(false); overlayShown = false; dragWin = null; STATE.work = null;
    stopWatch();
    log("picker closed:", reason);
}

/* Watchdog while the picker is up. It makes sure the picker always comes down,
 * because a drag can end without interactiveMoveResizeFinished (a screenshot
 * tool or another app steals the move grab). Three ways it closes:
 *   - the user left/right-clicks the overlay (reported via pollPick → cancel),
 *   - the window stops moving, or
 *   - a 20s hard timeout (80 * 250ms) as an absolute backstop.
 * Self-stops once the picker is hidden. */
function startWatch() {
    if (watchT) return;
    watchTicks = 0;
    watchT = new QTimer();
    watchT.interval = 250;
    watchT.timeout.connect(function () {
        if (!overlayShown) { stopWatch(); return; }
        watchTicks++;
        ovPoll(function (r) {                        // click-to-close
            if (!r) return;
            try { if (JSON.parse(r).cancel) abortPicker("clicked"); } catch (e) {}
        });
        if (!dragWin || !dragWin.move) abortPicker("drag interrupted");
        else if (watchTicks >= 80) abortPicker("timeout");
    });
    watchT.start();
}
function stopWatch() { if (watchT) { watchT.stop(); watchT = null; } }

function onStepped() {
    if (!dragWin) return;
    if (!STATE.work) STATE.work = screenWork();
    var p = workspace.cursorPos;
    var triggerY = STATE.work.y + CFG.trigger_px;

    if (!overlayShown) {
        // Trigger when the cursor OR the dragged window's top edge reaches the
        // top band — dragging by a low titlebar keeps the cursor well below the
        // edge, so the window-top check is what makes it feel like Windows 11.
        var wtop = dragWin.frameGeometry ? dragWin.frameGeometry.y : 9999;
        if (p.y <= triggerY || wtop <= STATE.work.y + CFG.trigger_px) {
            var built = computeCards(STATE.work);
            STATE.cards = built.cards;
            STATE.zones = built.zones;
            ovState({ cards: STATE.cards, zones: STATE.zones, highlight: null, preview: null });
            ovShow(true);
            overlayShown = true;
            startWatch();
            log("picker shown");
        }
        return;
    }
    var hit = zoneAt(p.x, p.y);
    ovState({
        cards: STATE.cards, zones: STATE.zones,
        highlight: hit ? { c: hit.c, z: hit.z } : null,
        preview: hit ? hit.target : null
    });
}

function onFinished() {
    stopWatch();
    if (overlayShown && dragWin) {
        var p = workspace.cursorPos;
        var hit = zoneAt(p.x, p.y);
        if (hit) {
            var tm = workspace.tilingForScreen(workspace.activeScreen);
            // Only rebuild if the layout isn't already in place — otherwise
            // flatten() would evict windows already snapped into this layout.
            if (!treeMatches(tm, TEMPLATES[hit.c])) applyTemplate(tm, TEMPLATES[hit.c]);
            var leaves = collectLeaves(tm.rootTile, []);
            if (leaves[hit.z]) {
                dragWin.tile = leaves[hit.z];
                log("snapped", dragWin.caption, "-> card", hit.c, "zone", hit.z);
                if (overlayShown) { ovShow(false); overlayShown = false; }
                dragWin = null;
                STATE.work = null;
                beginAssist(tm);   // offer to fill the remaining tiles
                return;
            }
        }
    }
    if (overlayShown) { ovShow(false); overlayShown = false; }
    dragWin = null;
    STATE.work = null;
}

function hook(win) {
    if (!win || !win.normalWindow) return;
    win.interactiveMoveResizeStarted.connect(function () {
        if (pollT) endAssist();          // a new drag dismisses Snap Assist
        dragWin = win; overlayShown = false; STATE.work = null;
    });
    win.interactiveMoveResizeStepped.connect(onStepped);
    win.interactiveMoveResizeFinished.connect(onFinished);
}

var wl = workspace.windowList();
for (var i = 0; i < wl.length; i++) hook(wl[i]);
workspace.windowAdded.connect(hook);

log("loaded; drag a window to the top edge to open the snap picker");
