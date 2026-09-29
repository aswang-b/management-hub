# Project Structure

## Tech stack
- **Runtime**: Node.js ≥ 22.13 (uses built-in `node:sqlite`), TypeScript run with `tsx`
- **Server**: Hono + `@hono/node-server`
- **Page**: React 19, Vite, `react-grid-layout` (grid), TipTap (notes editor), Recharts (analytics charts)
- **Storage**: one SQLite file, `data/hub.db` (`HUB_DB` overrides)
- **Tests**: Node's built-in test runner (`node --test`), network faked

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | Server (`node --watch`) + Vite dev page together; Ctrl+C stops both |
| `npm start` | Build the page, then serve everything from the server |
| `npm run serve` | Serve without rebuilding |
| `npm run typecheck` / `npm test` / `npm run build` | Checks before committing |
| `npm run check-plugins` | Run every plugin against the real services |

## File tree
```
.env.example            tokens each plugin needs (copy to .env)
server/
  index.ts              API routes under /api, host/origin guard, serves web/dist
  db.ts                 SQLite tables: projects, tools, cache
  metrics.ts            analytics: metrics table, combining, chart buckets
  collector.ts          hourly job running each plugin's collect()
  links.ts              site title/favicon lookup, open local files
  secrets.ts            save plugin tokens from the page into .env
  check-plugins.ts      npm run check-plugins
  plugins/
    framework.ts        Plugin interface, request(), expectShape(), optional()
    index.ts            plugin registry, 60 s result cache, runLoad/runAction
    github|supabase|netlify|cloudflare|resend|google|status.ts   one per service
    plugins.test.ts     tests for every plugin and action
  *.test.ts             metrics, db (restore), secrets, grid placement
shared/types.ts         types used by server and page (Project, Tool, PluginView, grid helpers)
shared/metrics.ts       analytics types, ranges, value formatting
web/
  index.html, public/   page shell, icon, PWA manifest
  src/
    App.tsx             project switcher, builder-mode toggle, Undo/Redo/Revert, Tokens
    useUndo.ts          builder-mode history (snapshots restored on the server)
    api.ts              fetch wrapper for /api
    components/         Workspace (grid), Palette, ToolSettings, ProjectSettings, Modal, Tokens
    tools/              registry.tsx, LinkTool, NotesModule, PluginTool, AnalyticsModule, charts
    styles.css          black/white theme
docs/
  project-brief.md      original request, API findings, planned modules
  ai-context/           this file and docs-overview.md
```

## Data model
- **Project**: a named workspace with a grid width (4–12 squares, `GRID_WIDTH`).
- **Tool**: one tile on a project's grid: `category` (link / plugin / module),
  `type`, position and size, `config` (settings) and `data` (e.g. notes text).

## How a plugin tile works
1. Page asks `GET /api/tools/:id/plugin`.
2. Server runs the plugin's `load()` with the tile's config and `.env` tokens.
3. Result (a `PluginView`) is cached 60 s and drawn by `PluginTool.tsx`.
4. Buttons call `POST /api/tools/:id/plugin/actions/:action`.

## How analytics numbers flow
1. `collector.ts` runs each plugin tile's `collect()` hourly (and at startup).
2. Points go into the `metrics` table (one per metric + tags + hour).
3. An analytics tile asks `GET /api/tools/:id/analytics`; `metrics.ts`
   combines the range and returns chart buckets and the limit.
