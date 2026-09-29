# web/src/

The React page. Built by Vite into `web/dist`, which the server serves.

## Key files
- `App.tsx`: loads projects and plugins, project switcher (URL `#/p/<id>`),
  builder-mode toggle, project settings.
- `api.ts`: small fetch wrapper for `/api`.
- `components/Workspace.tsx`: the grid (`react-grid-layout`). In builder mode
  tiles can be added, moved, resized to allowed sizes, configured, removed.
  On phones (< 640 px) links sit 4 per row and everything else is full width.
- `components/Palette.tsx`: list of tools to drag in, with size shapes.
- `components/ToolSettings.tsx`, `ProjectSettings.tsx`, `Modal.tsx`: dialogs.
  `Modal` renders into `document.body` (a portal) so dialogs opened from a
  tile aren't clipped by the grid's transformed items.
- `components/Tokens.tsx`: token rows (status, steps, link, paste box) used by
  the top bar's Tokens dialog, plugin settings and a tile's "Add token". Saving
  fires `TOKENS_CHANGED`; `App` reloads the plugin list and plugin tiles reload.
- `useUndo.ts`: Undo/Redo/Revert. `Workspace` calls `onBeforeChange()` before
  each change; snapshots are restored through `POST /projects/:id/restore`,
  then the workspace remounts (App's `rev` key).
- Dragging: `Workspace` gives the grid a custom compactor that runs
  `makeRoom` (`shared/types.ts`) from the tools' saved spots on every move, so
  pushed tools slide back. Positions are saved only on drag stop and drop.
- In `npm run dev`, Vite forwards `/api` without changing the Host header
  (`changeOrigin: false`), or the server's cross-site check refuses changes.
- `tools/registry.tsx`: every tool type and its allowed sizes. Plugins are
  added automatically from the server's plugin list (`buildRegistry`).
- `tools/LinkTool.tsx`: a link or local file with favicon.
- `tools/NotesModule.tsx`: rich-text notes (TipTap), saved to the tile's `data`.
- `tools/PluginTool.tsx`: draws any `PluginView` generically.
- `tools/AnalyticsModule.tsx`: the analytics tile and its definition
  (`analyticsDef`: sizes, settings, metric list, "Collect now"). Display
  depends on size: 1×1 number, 1 tall sparkline, 2+ tall full chart.
- `tools/charts.tsx`: `Sparkline` (hand-drawn SVG) and `FullChart` (Recharts).
- `components/ToolSettings.tsx` supports `select` fields, choices loaded by
  a tool's `loadSettings()`, and one extra button (`settingsAction`).
- `styles.css`: the theme.

## Patterns
- Strict black/white, sharp corners. Status uses glyphs (● ▲ ■ ◐ ○) and
  inversion, never colors.
- Grid width 4–12 squares (`GRID_WIDTH` in `shared/types.ts`).
- Adding a new non-plugin tool type: a component in `tools/` plus an entry in
  `registry.tsx` with its sizes.
