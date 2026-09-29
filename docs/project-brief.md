# Project brief

The original request for the hub, the investigation that answered it
(researched 2026-09-28), and what has been built so far. When the hub
changes, update the **Built?** notes so this stays accurate.

## The problem

Side projects like `bachata-website` are spread across many services: the
GitHub repo, Supabase, Google Cloud (sign-in audience), Resend, Cloudflare and
Netlify. Each has its own website and login. Visits to them are almost always
for one of three jobs:

1. **Maintenance**: rebuild, re-run, restore, purge, re-verify.
2. **Analytics**: traffic, emails sent, deploy history.
3. **Billing limits**: making sure nothing goes over its free or paid plan.

Keeping many tabs and logins open for this is confusing. The hub brings those
three jobs into one page.

## Ground rules

- **Easy to run.** It must not become one more thing to maintain.
- **Local.** It runs on your own computer, and its code lives in a GitHub repo.
- **Few trips to other sites.** Where a service allows it, do the job inside
  the hub. Some jobs can't avoid opening the service's own site.
- **Claude-friendly.** Use one lightweight language that Claude can work in
  fully, because the owner is not an experienced developer.

## Terms

| Term | Meaning |
|---|---|
| **Project** | A named collection of tools, shown as one page. |
| **Workspace** | A project's grid of squares. Tools sit on it. |
| **Tool** | Anything placed on the grid. Its category and its size (squares wide × tall) matter most. |
| **Link** | A tool that opens a website or a file. |
| **Plugin** | A tool that shows information or actions from an outside service. Services change their APIs, so plugins must be easy to update. |
| **Module** | A tool built into the hub itself, not taken from another site. |
| **Builder mode** | The mode for adding, moving, resizing and removing tools. |

## Specification and status

| Requirement | Built? |
|---|---|
| Minimalist black/white theme, sharp lines and corners | Yes |
| Projects listed by name in the top bar, plus a button to add one | Yes |
| Each project is a blank page with a grid (the workspace) | Yes |
| Tools added in builder mode and saved | Yes |
| Grid width 6 by default, adjustable from 4 to 12 in project settings. More squares make tools smaller; the page width stays the same | Yes |
| Link tool in 3 sizes (1, 2 or 3 squares wide, 1 tall), showing the site's icon, and its name when 2 or 3 wide | Yes |
| Notes module: rich text with lists, numbering, highlighting and text color, saved with the project | Yes |
| Plugins for the `bachata-website` services (section 1) | Yes, with the gaps listed there |
| Second module: generic analytics that outside sources can send data into (section 2) | **Partly.** Storage, hourly pull from plugins and the chart tile are built; push and import aren't |
| Usable as a phone app while hosted on the computer (section 4) | Yes, without offline caching |

---

## 1. Embedding and managing the services

**Embedding doesn't work.** GitHub, Supabase Studio, Google Cloud Console,
Resend, Cloudflare and Netlify all refuse to be shown inside another site (they
send `X-Frame-Options: DENY` or a `frame-ancestors` rule). That's a security
choice and won't change.

**APIs are the way in.** Every service except Google's sign-in "Audience" page
has an API covering most of what you do in its website. Plugins call those
APIs from the hub's server and draw their own black/white tiles. Tokens live
only in `.env` on your computer, never in the browser or in git.

| Service | Maintenance via API | Analytics | Billing / usage | Token |
|---|---|---|---|---|
| **GitHub** | Re-run Actions runs, run a workflow by hand, PRs, issues, Dependabot alerts, releases | Repo traffic (views, clones, referrers), kept by GitHub for only 14 days | Actions minutes and billing usage | Fine-grained token for the one repo |
| **Supabase** | Project status, pause/restore, backups, run SQL, auth settings, edge functions | API request counts and logs | No billing API. Database size and row counts (via SQL) show how close you are to free-tier limits | Personal access token (`api.supabase.com/v1`) |
| **Google Cloud** | The sign-in Audience page (publishing status, test users) has **no API**. Monitoring and Billing Budgets APIs exist but need a service account | Cloud Monitoring (only if you run things in Google Cloud) | Billing Budgets API or billing export | Service account key (more setup) |
| **Resend** | Domains (status, re-verify), API keys, contacts, broadcasts, sent emails | Status of each email (delivered, bounced, opened) | No single quota endpoint. Count sent emails per day and month against the limit | API key |
| **Cloudflare** | DNS records, cache purge, Pages deploys, SSL status, firewall rules | Requests, bandwidth, threats, page views (GraphQL Analytics API) | Free plan mostly not billed; Workers/Pages usage via GraphQL | Scoped API token |
| **Netlify** | Deploys: retry, roll back, lock, build hooks, env variables, form submissions | Netlify Analytics is a paid add-on | Allowance and period on the account (undocumented `capabilities.credits`, whose `used` stays 0); credits used must be estimated from production deploys and `/accounts/{slug}/bandwidth`. No API reports web-request or compute credits (checked 2026-09-28) | Personal access token |

What this means for the design:

- **Google's Audience page stays a link**, since it has no API and is rarely touched.
- **Supabase's free-tier auto-pause** (after about 7 days without activity) is
  the most valuable thing to watch: show last activity, warn before a pause,
  restore in one click.
- **Status pages are free.** GitHub, Supabase, Cloudflare, Netlify and Resend
  all publish `/api/v2/summary.json`, so one plugin covers them with no login.
- **Plugins must survive API changes.** Each service is one file on the
  server that pins the API version, checks the response shape (so a changed
  API shows "Plugin needs an update" instead of breaking the page), and can
  be tested with `npm run check-plugins`.
- **Risky actions** (roll back, pause, purge cache) ask before running.

**Built?** Yes: one file per service in `server/plugins/`, API versions
pinned, shape checks, `check-plugins`, confirmations, and the status-page
plugin. Google is a plugin tile of open incidents plus shortcut links, since
Google has no API for those pages. **Not yet:** GitHub traffic and billing
numbers, Supabase last-activity and pause warning, Cloudflare DNS and Pages
deploys, Netlify deploy locking and build hooks.

---

## 2. The analytics module (partly built)

One module that can chart numbers from anywhere. Keep **getting data in**
separate from **showing it**.

### One table for every data point

| Field | Type | Example |
|---|---|---|
| `metric` | text | `netlify.bandwidth_gb`, `resend.emails_sent` |
| `ts` | time | when the value applies |
| `value` | number | `2140` |
| `tags` | JSON, optional | `{"site":"bachata","status":"bounced"}` |
| `source` | text | which plugin or push key wrote it |

Grafana, Prometheus and InfluxDB store data the same way, and it fits
nearly any number: page views, email counts, database size, build minutes.
It would be a new table in `data/hub.db`.

### Three ways data gets in

1. **Pull (the default).** Plugins run on a schedule (for example hourly)
   and save points. This works with the hub being local and also keeps
   GitHub traffic past its 14 days. The hub has no scheduler yet.
2. **Push.** `POST /api/ingest` accepts `{metric, value, ts?, tags?}` (one or
   many), with a key per source. Any script or scheduled job can send data.
   The hub only accepts requests from your computer and your Tailscale
   devices, so outside services can't reach it without a tunnel.
3. **Import.** Paste or upload a CSV or JSON export, matching its columns once.

Webhooks from Resend, Netlify and GitHub are a kind of push. They need the
hub reachable from the internet, so they wait; pulling covers the same data.

### Showing data

The module's settings pick the metrics and tags, time range, and how to
combine values (sum, average, latest, count). The display fits the tile size:

| Tile size | Display |
|---|---|
| 1 × 1 | One big number with change vs. the previous period |
| 2 or 3 wide, 1 tall | Small line or bar chart |
| 2 × 2 and up | Full chart with legend |
| Limit gauge (any size) | Value against a set limit, e.g. "Resend: 2,140 / 3,000 emails this month", switching to the warning style past a threshold. Serves the billing-limits job |

Chart library: Recharts or uPlot (easy to keep black/white).

**Built?** Partly:

- The `metrics` table (`server/metrics.ts`). A reading for the same metric,
  tags and hour replaces the old one, so re-running a collection doesn't
  double-count. A limit is saved as a second metric named `<metric>.limit`,
  and the tile finds it by itself.
- Pull: plugins can have a `collect` step; `server/collector.ts` runs it for
  every plugin tile when the hub starts (if this hour isn't done) and then
  hourly. Resend (emails today/month, bounces, limits) and Netlify
  (credits used/left and allowance; bandwidth on older plans) save numbers.
- The Analytics tile with all four displays, sum/average/latest/count, a
  "Collect now" button, and Recharts for the full chart.

**Not yet:** push (`POST /api/ingest` with per-source keys), CSV/JSON
import, and other plugins saving numbers (GitHub traffic, Cloudflare,
Supabase database size).

---

## 3. Language and framework

**TypeScript everywhere, one small Node.js app, one SQLite file.**

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript | Same as bachata-website (Astro). Types catch mistakes. |
| Page | React + Vite | Largest ecosystem; the two hardest parts exist as React libraries. |
| Grid and builder mode | `react-grid-layout` | Drag, drop and resize on a column grid; 4 to 12 columns is a setting. |
| Notes | Tiptap | Lists, numbering, highlight and text color are official extensions. |
| Charts | Recharts | Simple, easy to theme. Written like the rest of the page. |
| Server | Hono | Tiny. Serves the page, stores data, calls APIs with your tokens. |
| Storage | SQLite (Node's built-in) | No database server. Back up by copying one file. |
| Run it | `npm start` | One command, one process. |

Considered and not chosen: **Python + FastAPI + HTMX** is lightweight too,
but the grid builder and rich-text editor are much harder without the
libraries above. **Next.js / SvelteKit** add concepts a one-person local app
doesn't need.

**Built?** Yes, as above.

---

## 4. Phone access while hosted locally

**Yes.**

1. The hub runs on your computer as usual.
2. [Tailscale](https://tailscale.com) (free for personal use) on the computer
   and phone makes a private network only your devices can join. Nothing is
   exposed to the internet.
3. `tailscale serve` gives the hub a private HTTPS address ending `.ts.net`.
4. On the phone, **Add to Home Screen** opens the hub full screen like an app.
   That needs HTTPS, which step 3 provides.

Limits: the computer must be on and awake. On narrow screens link tiles sit
four to a row and every other tool takes the full width. Builder mode is
desktop-only.

Alternative: **Cloudflare Tunnel + Cloudflare Access**. It needs no app on
the phone, but puts the hub on a public address behind a login, which is more
to get right. It's also the route to take later if webhooks are wanted.

**Built?** Yes: phone layout, home-screen app details and the Tailscale steps
in the README. **Not yet:** offline caching (a "service worker") so the app
opens instantly with the last-seen data when the computer is off.

---

## 5. Similar tools for inspiration

| Tool | What to borrow |
|---|---|
| **Homepage** (gethomepage.dev) | Closest to our plugins: 100+ service widgets that call APIs with a key. Its per-service widget files are a good template. |
| **Homarr** | Drag-and-drop board editor on a grid. Closest to builder mode. |
| **Dashy** | Multiple pages, status checks per link, theming. |
| **Glance** | Clean minimalist dashboard; reference for a sharp, text-first look. |
| **Heimdall / Organizr** | Simple link-tile launchers; reference for icon + name link tiles. |
| **Grafana** | Model for the analytics module: data sources kept separate from panels on a grid. |
| **Backstage** (Spotify) | One plugin per external tool, at a much bigger scale. |
| **Uptime Kuma** | Status monitoring; reference for health and alert tiles. |
| **Notion** | Block-based pages; the feel of the notes module. |

Homepage, Homarr and Dashy could be used as they are. Building our own is
worth it for the Project/tool model, the notes and analytics modules, and
full control by Claude.
