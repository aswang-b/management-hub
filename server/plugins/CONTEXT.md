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
  `vercel` (deploys in 24h; billed this month on Pro).

## Helpers
- `request(url, opts)`: HTTP with errors turned into plain-language messages.
- `expectShape(ok, service, what)`: call on the main response so API changes
  show "Plugin needs an update" instead of crashing.
- `optional(promise)`: for non-essential calls; failure returns `undefined`.
- `request(url, { text: true })` returns the raw body (e.g. JSON Lines).
- `PluginError(kind, message)`: kinds: `setup`, `auth`, `not-found`, `changed`, `network`, `other`.
- `ago`, `bytes`, `num`: formatting.

## `index.ts`
- `runLoad`: caches results 60 s per tile + config.
- `runAction`: runs an action, then clears that tile's cache.
- `runCollect`: runs `collect`; never throws, returns `{ ok, points, error }`.
- `ctx.secret(key)` throws a setup error naming the missing `.env` key.

## Adding a plugin (checklist)
1. New `<service>.ts` exporting a `Plugin`.
2. Add it to the `plugins` array in `index.ts`.
3. Token in `env` (with `url` and `steps`) and in `.env.example`: where to create it, which permissions.
4. Row in the README plugin table.
5. Tests in `plugins.test.ts` (network is faked) for `load` and each action.
6. Actions that delete or publish set `confirm`.
7. Numbers worth charting: add `collect` and a test for it.
No page changes should be needed.
