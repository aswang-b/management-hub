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
- `tools/registry.tsx`: every tool type and its allowed sizes. Plugins are
  added automatically from the server's plugin list (`buildRegistry`).
- `tools/LinkTool.tsx`: a link or local file with favicon.
- `tools/NotesModule.tsx`: rich-text notes (TipTap), saved to the tile's `data`.
- `tools/PluginTool.tsx`: draws any `PluginView` generically.
- `styles.css`: the theme.

## Patterns
- Strict black/white, sharp corners. Status uses glyphs (● ▲ ■ ◐ ○) and
  inversion, never colors.
- Grid width 4–12 squares (`GRID_WIDTH` in `shared/types.ts`).
- Adding a new non-plugin tool type: a component in `tools/` plus an entry in
  `registry.tsx` with its sizes.
