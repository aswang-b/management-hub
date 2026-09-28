# server/

The local API and static file server. Started by `npm run dev` / `npm start`.

## Key files
- `index.ts`: loads `.env`, mounts the API under `/api`, serves `web/dist`.
  Middleware refuses unknown hosts (localhost, `*.ts.net`, `HUB_ALLOWED_HOSTS`),
  cross-origin requests and non-JSON writes.
- `db.ts`: SQLite through `node:sqlite`. Tables `projects`, `tools`, `cache`
  (favicons and link titles). Helpers: list/get/create/update/delete for
  projects and tools, `saveLayout`, `cacheGet`/`cacheSet`, `clampWidth`.
- `links.ts`: `linkInfo` (site title + icon), `favicon`, `openLocal`
  (open a local file or folder from a link tile).
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
- Port is `HUB_PORT` (default 8787), host `HUB_HOST` (default 127.0.0.1).
- Tests that need the database set `HUB_DB=":memory:"` before importing it
  (see `metrics.test.ts`).
