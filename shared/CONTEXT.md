# shared/

Code used by both the server and the page. Import it with a relative path
(`../shared/…` from `server/`, `../../shared/…` from `web/src/`). Keep it free
of Node-only and browser-only APIs so both sides can run it.

## Key files
- `types.ts`: the data model and the plugin contract.
  - `Project`, `Tool` (category, type, position/size, `config`, `data`), `GRID_WIDTH` (4–12).
  - Plugin view: `PluginView`, `PluginItem`, `PluginAction`, `Tone`, `PluginResult`.
  - Plugin metadata: `PluginMeta`, `EnvVar` (token `key`, `help`, `url`, `steps`),
    `PluginConfigField` (`text` / `number` / `select`, `timestamped`).
  - Grid placement (pure functions, tested in `server/grid.test.ts`):
    `overlaps`, `firstFreeSpot`, `refit` (fit tools into a narrower grid),
    `makeRoom` (where the other tools go while one is dragged), `nearestFreeSpot`.
- `metrics.ts`: the analytics module's shared pieces.
  - `MetricPoint`, `Series`, `CollectRun`, `AnalyticsResult`.
  - `RANGES` (24h/7d/30d/90d and their chart buckets), `COMBINE` (latest/sum/avg/count).
  - `LIMIT_SUFFIX`: a limit is saved as `<metric>.limit`.
  - `tagKey` (stable tag order), `seriesLabel`, `formatValue` (`_bytes` names show as sizes).

## Patterns
- `makeRoom` always starts from the tools' saved spots (`home`), so tools pushed
  aside during a drag slide back when the dragged tool moves on. Tools that
  don't touch the dragged one keep their spot; the rest go to the nearest free spot.
- Adding a field to a shared type? Check both `server/` and `web/src/` still
  type-check (`npm run typecheck`).
