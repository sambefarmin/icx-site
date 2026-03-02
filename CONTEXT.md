# ICX Site — AI Session Context

This file gives any new AI session (or developer) full context to continue working on this project without needing prior conversation history.

---

## What This Site Is

**icx.global** — a real-time H100 GPU spot price aggregator. It shows per-provider $/GPU-hr prices, computes the ICX Rate (trimmed mean of all providers), and lets users filter/sort providers and click into 30-day price history charts.

Previously a static GitHub Pages site with simulated prices. Now a full-stack app on Vercel with a Supabase Postgres backend.

---

## Stack

| Layer | Service | Notes |
|---|---|---|
| Frontend | Vercel (static) | `index.html` — single-page, no build step |
| API / Cron | Vercel Serverless Functions | `api/` directory, Node >=18 |
| Database | Supabase (Postgres) | Migrations auto-run via GitHub integration |
| DNS | GoDaddy → Vercel | A record 216.198.79.1, www CNAME → eff9a26e42cbbbe4.vercel-dns-017.com |

**Deployed URLs:**
- Production: https://icx.global
- Vercel URL: https://icx-site-wine.vercel.app
- GitHub repo: https://github.com/sambefarmin/icx-site

---

## Repository Structure

```
icx-site/
├── index.html                  # Full frontend (no framework, vanilla JS + Supabase CDN)
├── vercel.json                 # Vercel config + cron schedule
├── package.json                # { "@supabase/supabase-js": "^2.39.0" }
├── .env.example                # Env var template
├── .gitignore
├── SETUP.md                    # One-time setup guide
├── CONTEXT.md                  # This file
├── api/
│   ├── scrape.js               # Cron: runs all scrapers hourly, stores snapshots, recomputes ICX rate
│   ├── prices.js               # GET: returns latest_prices view + most recent ICX rate
│   ├── history.js              # GET ?days=30: returns icx_rate_history
│   └── update.js               # POST: manual price update (auth: ADMIN_SECRET Bearer token)
├── lib/
│   ├── supabase.js             # Server-side Supabase client (service_role key)
│   ├── scrapers.js             # Automated scrapers: Lambda Labs, Azure, Vast.ai, RunPod
│   └── icx.js                  # calcICXRate(prices) — trimmed mean (drop bottom+top 15%)
└── supabase/
    └── migrations/
        ├── 20260302000000_init.sql              # Schema + initial seed
        ├── 20260302000001_fix_providers.sql     # Corrected provider names
        └── 20260302000002_seed_prices_from_excel.sql  # Feb 24 2026 Excel import (26 providers)
```

---

## Database Schema

### Tables

**`providers`**
```sql
id          uuid PRIMARY KEY DEFAULT gen_random_uuid()
name        text UNIQUE NOT NULL
tier        text  -- 'hyperscaler' | 'specialist' | 'marketplace'
region      text
website     text
created_at  timestamptz DEFAULT now()
```

**`price_snapshots`**
```sql
id           uuid PRIMARY KEY DEFAULT gen_random_uuid()
provider_id  uuid REFERENCES providers(id)
price_usd    numeric(10,4)       -- per GPU per hour
is_available boolean DEFAULT true
scraped_at   timestamptz DEFAULT now()
source       text                -- 'auto' | 'manual' | 'seed'
```

**`icx_rate_history`**
```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
rate            numeric(10,4)
provider_count  int
min_price       numeric(10,4)
max_price       numeric(10,4)
computed_at     timestamptz DEFAULT now()
```

**`latest_prices` (VIEW)**
```sql
-- DISTINCT ON provider_id, ordered by scraped_at DESC
-- Returns: provider_id, name, tier, region, website, price_usd, is_available, scraped_at
```

### RLS
- `providers`: public SELECT
- `price_snapshots`: public SELECT
- `icx_rate_history`: public SELECT
- All writes require service_role key (server-side only)

---

## Environment Variables

Set in Vercel dashboard (Settings → Environment Variables):

| Variable | Value / Where to find |
|---|---|
| `SUPABASE_URL` | `https://xelzbbgbfhkdlqfzawpb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |
| `CRON_SECRET` | `icx-cron-2026` |
| `ADMIN_SECRET` | `icx-admin-2026` |

**Frontend (public, hardcoded in index.html):**
- Supabase URL: `https://xelzbbgbfhkdlqfzawpb.supabase.co`
- Supabase anon key: `sb_publishable_WwVV9q2p27ENF7fDx69caQ_jpExegjf`

---

## Providers

26 providers seeded as of Feb 24 2026. Tiers:

**Hyperscaler:** AWS (p5), Google Cloud (a3), Azure (NC H100)

**Specialist:** Lambda Labs, CoreWeave, Hyperstack, GMI Cloud, Nebius, FluidStack, CUDO Compute, Verda, Civo, OVH, Scaleway, Sesterce, Koyeb, Together AI, Oblivus, Gcore, Vultr

**Marketplace:** RunPod (Secure), RunPod (Community), Vast.ai, TensorDock, Jarvislabs, Thunder Compute, DigitalOcean, Paperspace, Novita AI

---

## Automated Scrapers

Run hourly via Vercel Cron (`0 * * * *` → `GET /api/scrape?secret=icx-cron-2026`).

| Provider | Method |
|---|---|
| Lambda Labs | REST API (public) |
| Azure (NC H100) | Azure Retail Prices API |
| Vast.ai | bundles API |
| RunPod (Secure) | GraphQL API |
| RunPod (Community) | GraphQL API |

All other providers require manual updates via `POST /api/update`.

---

## Manual Price Update

```bash
curl -X POST https://icx.global/api/update \
  -H "Authorization: Bearer icx-admin-2026" \
  -H "Content-Type: application/json" \
  -d '{"providerName": "CoreWeave", "priceUsd": 6.16, "isAvailable": true, "region": "US East"}'
```

Provider name must exactly match the `name` field in the `providers` table.

---

## ICX Rate Calculation

Trimmed mean: sort all available provider prices, drop the bottom 15% and top 15%, average the rest. Implemented in `lib/icx.js` (`calcICXRate(prices)`). Result stored in `icx_rate_history` on every scrape or manual update.

---

## Frontend Features (index.html)

- Loads Supabase JS from CDN, queries `latest_prices` view directly (anon key, public RLS)
- Polls for fresh data every 5 minutes
- **Filter bar**: tier pills (All / Hyperscaler / Specialist / Marketplace), "Available Only" toggle, provider name search
- **Sortable columns**: Provider, Tier, $/GPU-hr, Δ vs ICX
- **Clickable rows**: opens modal with 30-day price history
  - Stats: Period High / Low / Avg / Data Points
  - SVG sparkline chart drawn from `price_snapshots` table
- ICX Rate banner at top with 30-day chart from `icx_rate_history`

---

## Migrations

Supabase is connected to the GitHub repo. Any `.sql` file added to `supabase/migrations/` and pushed to `main` will be automatically applied to the database.

Naming convention: `YYYYMMDDHHMMSS_description.sql` — must be lexicographically greater than all existing migrations.

Next migration should be named: `20260302000003_...sql` or later.

---

## Providers Needing Manual Price Updates

These providers are in the DB but have no recent automated scraper. Update them via `/api/update`:
- GMI Cloud
- TensorDock
- Jarvislabs
- CoreWeave
- AWS (p5)
- Google Cloud (a3)
- (and most specialist/marketplace providers)

---

## Common Tasks for Future Sessions

**Add a new provider:**
1. Create migration: `INSERT INTO providers (name, tier, region, website) VALUES (...)`
2. Push to `main` — Supabase auto-applies
3. Add initial price snapshot via `/api/update`

**Add a new automated scraper:**
1. Write scraper function in `lib/scrapers.js`
2. Add entry to `SCRAPERS` map with exact provider name matching DB
3. Push to `main` → Vercel redeploys automatically

**Update prices manually:**
Use the `POST /api/update` curl command above.

**Redeploy frontend:**
Push any change to `main` — Vercel auto-deploys.
