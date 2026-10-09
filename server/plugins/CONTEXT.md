# server/plugins/

One file per outside service. Each exports a `Plugin` (see `framework.ts`).

## Current plugins
`github`, `supabase`, `netlify`, `vercel`, `cloudflare`, `resend`, `google`, `status`
(registered in `index.ts`, in that order).

## The Plugin shape (`framework.ts`)
- `id`, `name`, `description`, `portalUrl(config)`
- `env`: tokens needed from `.env`: `key`, one-line `help`, the service's
  `url` for creating one, and `steps` shown in the hub's Tokens dialog
- `configFields`: settings asked for in builder mode (e.g. repository)
- `load(ctx)`: returns a `PluginView` (status, stats, sections, actions, links)
- `actions`: named functions for buttons; return a short message
- `collect(ctx)` (optional): numbers to save hourly for analytics, as
  `{ metric, value, tags? }`. Add a `<metric>.limit` point for a gauge.
  Used by `resend`, `netlify` (credits, or bandwidth on older plans) and
  `vercel` (deploys in 24h, 30-day transfer/invocations/requests; billed this month on Pro).

## Helpers
- `request(url, opts)`: HTTP with errors turned into plain-language messages.
- `expectShape(ok, service, what)`: call on the main response so API changes
  show "Plugin needs an update" instead of crashing.
- `optional(promise)`: for non-essential calls; failure returns `undefined`.
  Don't read meaning into that `undefined`: when a known answer means
  something (e.g. Vercel's billing 404 means Hobby), pass `allow: [404]`
  so it comes back as `null`, and treat `undefined` as "unknown".
  Don't wrap lookups whose failure would send later calls to the wrong place
  (Vercel's default team).
- `request(url, { text: true })` returns the raw body (e.g. JSON Lines).
- `PluginError(kind, message)`: kinds: `setup`, `auth`, `not-found`, `changed`, `network`, `other`.
- `ago`, `bytes`, `num`: formatting.

## `index.ts`
- `runLoad`: caches results 60 s per tile + config.
- `runAction`: runs an action, then clears that tile's cache.
- `runCollect`: runs `collect`; never throws, returns `{ ok, points, error }`.
- `ctx.secret(key)` throws a setup error naming the missing `.env` key.
- A plugin may keep a small in-memory cache (Vercel remembers the default
  team per token for an hour); export a way to clear it and call that in the
  tests' `beforeEach`.

## Adding a plugin (checklist)
1. New `<service>.ts` exporting a `Plugin`.
2. Add it to the `plugins` array in `index.ts`.
3. Token in `env` (with `url` and `steps`) and in `.env.example`: where to create it, which permissions.
4. Row in the README plugin table.
5. Tests in `plugins.test.ts` (network is faked) for `load` and each action.
6. Actions that delete or publish set `confirm`. Action `args` come from the
   request, so check that ids belong to the tile's project (see Vercel's
   `ownDeployment`) or read them from the service instead.
7. Numbers worth charting: add `collect` and a test for it.
No page changes should be needed.
