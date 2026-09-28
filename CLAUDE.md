# Management Hub

Locally hosted dashboard for managing Alex's other projects. Alex is not an
experienced developer: keep the stack small, explain changes in plain words,
and keep README.md accurate for a non-developer.

`docs/project-brief.md` holds the original request and the investigation
behind it: the goal (maintenance, analytics and billing limits in one local
page), domain terms, what each service's API allows, the design for the next
module (generic analytics, not built yet), the stack choice, phone access and
similar tools. Read it before adding features. Its **Built?** notes list
known gaps; update them when something from it is built.

## Layout
- `server/index.ts`: Hono API routes + serves `web/dist`. Loads `.env` itself.
  API middleware refuses unknown hosts (allowed: localhost, `*.ts.net`,
  `HUB_ALLOWED_HOSTS`), cross-origin requests, and non-JSON writes.
- `server/links.ts`: link tool helpers (site name/favicon lookup, open local files).
- `server/check-plugins.ts`: `npm run check-plugins`, runs every plugin against real services.
- `server/db.ts`: SQLite via built-in `node:sqlite` (file `data/hub.db`, `HUB_DB` overrides).
- `server/plugins/*.ts`: one file per service. Each exports a `Plugin`
  (`framework.ts`) and is registered in `plugins/index.ts`.
- `web/src/`: React page. `tools/registry.tsx` lists tool types and sizes;
  `components/Workspace.tsx` is the grid and builder mode.
- `shared/types.ts`: shared types, including `PluginView`.

## Conventions
- Plugins return a `PluginView` (status, stats, sections of items, actions,
  links). The page renders it generically with `PluginTool.tsx`; a new plugin
  should need no page changes. It does need: registration in `plugins/index.ts`,
  its token in `.env.example` (where to create it, which permissions), a row in
  the README plugin table, and tests in `plugins/plugins.test.ts`.
- Use `request()` from `framework.ts` for HTTP so errors become plain-language
  messages. Call `expectShape()` on the main response so API changes show
  "Plugin needs an update" instead of crashing. Wrap non-essential calls in `optional()`.
- Actions that are destructive or publish something set `confirm`.
- Tokens only come from `.env` via `ctx.secret()`; never send them to the page.
- Theme is strictly black/white with sharp corners (see `web/src/styles.css`).
  Status is shown with glyphs (● ▲ ■ ◐ ○) and inversion, not colors.
- Grid width is 4 to 12 squares (`GRID_WIDTH`). Tool sizes are in `registry.tsx`.

## Checks before committing
`npm run typecheck && npm test && npm run build`
Plugin tests fake the network; add a test for each new plugin or action.
