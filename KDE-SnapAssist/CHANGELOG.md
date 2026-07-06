# Changelog

## 0.0.1 — 2026-07-06

First release. Windows 11-style snap layouts and Snap Assist for KDE Plasma 6
(KWin 6, Wayland), built on top of KDE's own tiling engine.

- Drag a window to the top edge to open a picker of 6 layout templates
  (Halves, Top/bottom, Thirds, Wide+side, Quarters, Main+stack), with a live
  full-screen preview of where the window will land.
- Dropping on a zone reshapes the screen's KWin tile tree to that template and
  snaps the window in — KDE handles the actual tiling, group resize and Wayland
  geometry.
- Snap Assist: after the first window is placed, the layout's empty tiles show
  the icons of your other open windows (minimized ones included); click one to
  fill the tile.
- Picker overlay sits on a solid theme-colored panel so it reads on any
  wallpaper; colors follow the live Plasma accent + light/dark.
- Robustness: opens whether the cursor or the window's top edge reaches the top;
  a watchdog + click-to-close + 20s timeout prevent the overlay sticking if a
  drag is interrupted.
- Per-user installer with login autostart (`install.sh`).
