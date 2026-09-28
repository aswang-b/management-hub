# Management Hub

A dashboard that runs on your own computer and puts the upkeep of your
other projects (GitHub, Supabase, Netlify, Cloudflare, Resend, Google Cloud)
in one place, so you don't need a dozen tabs and logins. It covers the three
reasons to visit those sites: taking maintenance actions, checking analytics,
and staying under billing limits.

The original request, what's built so far and what's planned are in
[docs/project-brief.md](docs/project-brief.md).

![Hub with the bachata-website project](docs/screenshot.png)

## What's in it

- **Projects** are listed across the top. `+ New` adds one.
- Each project is a **grid** of tools. The grid is 6 squares wide by default;
  change it (4 to 12) in project settings (⚙).
- **Build** turns on builder mode: drag tools from the left panel onto the
  grid (or click a size to drop it in the first free spot), drag tools around,
  change their size (⇲), edit their settings (⚙) or remove them (✕). Press
  **Done** when finished. Everything saves automatically.

  ![Builder mode](docs/builder-mode.png)

- **Tools** come in three kinds:
  - **Links** (1, 2 or 3 squares wide) open a website or a file on your
    computer. They show the site's icon, and its name when wider than one square.
  - **Modules** are built into the hub: **Notes**, rich text with lists,
    numbering, highlights and text colors, and **Analytics**, charts of
    numbers the hub saves every hour (see [Analytics](#analytics)).
  - **Plugins** show live information from a service and let you take its most
    common maintenance actions without opening the service's website:

| Plugin | Shows | Buttons |
|---|---|---|
| GitHub | Latest workflow runs, open PRs and issues, security alerts | Re-run (failed) workflows, run a workflow by hand |
| Supabase | Project status (paused?), service health, database size vs. limit, last backup | Restore a paused project, pause |
| Netlify | Recent deploys, bandwidth vs. plan | Rebuild, clear cache & rebuild, retry a failed deploy, roll back to an older deploy |
| Cloudflare | Zone status, SSL mode, DNS count, 7-day requests, visitors, bandwidth, cache rate, threats | Purge cache, toggle development mode |
| Resend | Domain verification, recent emails, emails sent today and this month vs. limits, bounces | Re-verify a domain, send a test email |
| Google Cloud | Open Google Cloud incidents | Shortcuts to the sign-in Audience, OAuth clients, branding, billing and quotas pages (Google has no API for these) |
| Service status | Live status of GitHub, Supabase, Cloudflare, Netlify and Resend | – |

Buttons that change something important ask before running.

## Analytics

Every hour, the hub saves a few numbers from the Resend and Netlify tiles in
your projects:

| From | Numbers |
|---|---|
| Resend | Emails sent today and this month (with your daily and monthly limits), bounces this month |
| Netlify | Bandwidth used this period (with your plan's allowance) |

An **Analytics** tile (under Modules in builder mode) charts one of these
numbers. Its settings (⚙) pick the number, the time range (24 hours to 90
days) and how to combine readings. What it shows depends on its size:

- **1 × 1**: the number, with the change against the period before (↑ 12%).
- **2 or 3 wide, 1 tall**: the number and a small line chart.
- **2 tall or more**: a full chart. Point at it to see each reading.

When a number has a limit, the tile also shows a bar like "79% of 3,000"
and a dashed limit line. Past 80% it shows ▲; past 100% the tile turns
black. The limit comes from the plugin (e.g. your Resend plan). Type a
different one in the tile's settings, or 0 for none.

Good to know:

- **Numbers are only saved while the hub is running.** Time when your
  computer was off shows as a gap in the chart.
- A new tile has nothing to show until the first save. The hub saves a few
  seconds after it starts, then every hour. **Collect now** in the tile's
  settings saves straight away.
- If a plugin can't save its numbers, the tile's settings say why.

## Setup

You need [Node.js](https://nodejs.org) 22.13 or newer.

```sh
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm start
```

Fill in the tokens you want in `.env`, then open <http://localhost:8787>.
Plugins without a token show what to add.

**Tokens** live only in `.env` on your computer. It is never committed to git.
`.env.example` lists each one, where to create it and which permissions to give.
Restart the hub after editing `.env`.

**Your data** (projects, tools, notes, saved numbers) is one file: `data/hub.db`. Copy it to
back up the hub.

## Using it from your phone

The page adapts to phone screens (builder mode needs a larger screen). To reach
the hub from your phone privately:

1. Install [Tailscale](https://tailscale.com) on your computer and phone and
   sign in to both with the same account.
2. On the computer, run `tailscale serve --bg 8787`. It prints a private
   `https://…ts.net` address that only your devices can open.
3. Open that address on your phone and choose **Add to Home Screen**.

Your computer needs to be on for the phone to reach it.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build the page and run the hub |
| `npm run serve` | Run the hub without rebuilding the page (faster, if nothing changed) |
| `npm run dev` | Run with live reload while changing the code (page on port 5173). Press Ctrl+C to stop it |
| `npm test` | Run the plugin tests |
| `npm run typecheck` | Check the code for type errors |
| `npm run check-plugins` | Try every plugin tile (and the numbers it saves for analytics) against the real services and report which ones fail |

## When a service changes its API

Each service is one file in `server/plugins/`. If a tile says **Plugin needs
an update**, run `npm run check-plugins` to see which one, then fix that file
(or ask Claude to). The page itself never needs to change for plugin fixes.

## How it's built

- `server/`: a small [Hono](https://hono.dev) server that stores data in SQLite
  and calls the services' APIs with your tokens, so tokens never reach the browser.
- `server/plugins/`: one file per service, plus `framework.ts` (shared
  helpers) and `index.ts` (the list of plugins).
- `web/`: the page, in React. Builder mode uses
  [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout);
  notes use [Tiptap](https://tiptap.dev); charts use [Recharts](https://recharts.org).
- Saved numbers live in a `metrics` table in `data/hub.db`
  (`server/metrics.ts`); `server/collector.ts` is the hourly job.
- `shared/types.ts`: types used by both sides, including the plugin "view"
  format every plugin returns.
