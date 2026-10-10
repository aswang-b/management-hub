# server/

The local API and static file server. Started by `npm run dev` / `npm start`.

## Key files
- `index.ts`: loads `.env`, mounts the API under `/api`, serves `web/dist`.
  Middleware refuses unknown hosts (localhost, `*.ts.net`, `HUB_ALLOWED_HOSTS`),
  cross-origin requests and non-JSON writes.
- `db.ts`: SQLite through `node:sqlite`. Tables `projects` (with `sides`: JSON
  side settings), `tools` (with `zone`: main/left/right), `scratchpads` (one row
  per project side: typed text and drawn strokes as JSON), `cache` (favicons
  and link titles; a site with no icon is retried after a day). Columns added later are created at startup if missing.
  Helpers: list/get/create/update/delete for projects and tools, `saveLayout`,
  `getScratch`/`saveScratch`, `cacheGet`/`cacheSet`, `clampWidth`.
  `updateProject` refits only the tools of a grid that got narrower.
- `links.ts`: `linkInfo` (site title + icon), `favicon`, `openLocal`
  (open a local file or folder from a link tile).
- `secrets.ts`: `saveToken` writes a plugin token into `.env` (keeping other
  lines) and into `process.env`, so it works without a restart. `tokenProblem`
  refuses pasted text with spaces or odd characters.
- `db.ts` also has `restoreProject(id, snapshot)` for builder mode's
  Undo/Redo/Revert: restores name, grid width, sides, tools (with their zone)
  and their settings, but keeps each surviving tool's `data` (e.g. notes
  text) and the scratchpads.
- `metrics.ts`: analytics storage. Creates the `metrics` table (metric, ts,
  value, tags, source; one row per metric + tags + hour). `savePoints`,
  `listSeries`, and `analytics(config)`, which combines a range, compares it
  with the previous range, splits it into chart buckets and finds the limit
  (`<metric>.limit`).
- `collector.ts`: runs every plugin tile's `collect` at startup (if this hour
  isn't done) and hourly; the last run's report is kept in the `cache` table.
- `check-plugins.ts`: runs every plugin (and its `collect`) with the real `.env` and prints results.
- `plugins/`: one file per service, see `plugins/CONTEXT.md`.

## Routes (`/api`)
| Route | Purpose |
|---|---|
| `GET/POST /projects`, `PATCH/DELETE /projects/:id` | Projects |
| `GET/POST /projects/:id/tools`, `PUT /projects/:id/layout` | Tiles on a grid |
| `POST /projects/:id/restore` | Put a project back to a snapshot (Undo/Redo/Revert) |
| `GET/PUT /projects/:id/scratch/:side` | A side's scratchpad (`left` / `right`) |
| `PUT /tokens/:key` | Save a plugin token to `.env` (only plugin token names; never read back) |
| `PATCH/DELETE /tools/:id` | One tile |
| `GET /plugins` | Plugin list + which tokens are set (never the tokens) |
| `GET /tools/:id/plugin` | Load a plugin tile (`?fresh=1` skips the cache) |
| `POST /tools/:id/plugin/actions/:action` | Press a plugin button |
| `GET /metrics` | Series with data + the last collection report |
| `POST /metrics/collect` | Collect plugin numbers now |
| `GET /tools/:id/analytics` | What an analytics tile shows |
| `GET /link-info`, `GET /favicon`, `POST /open` | Link tile helpers |

## Patterns
- Tokens are read only on the server (`ctx.secret()`); responses never include them.
- Grid width is clamped to `GRID_WIDTH` in `db.ts`.
- Port is `HUB_PORT` (default 8787), host `HUB_HOST` (default 127.0.0.1),
  settings file `HUB_ENV_FILE` (default `.env`; point it elsewhere for test runs).
- Trying the page without touching Alex's data (the real hub runs on 8787 as a
  background task): copy the database with `VACUUM INTO 'data/preview.db'`, run
  `npm run build`, then start the `hub-preview` launch config (port 8790, that copy).
  `npm run build` also changes what the running hub serves: `npm run app:restart` after.
- Tests that need the database set `HUB_DB=":memory:"` before importing it
  (see `metrics.test.ts`).
