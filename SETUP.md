# ICX Site — Real Price Database Setup Guide

This guide takes your site from simulated prices → real, memorialized spot prices stored in Supabase and served via Vercel.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│  Vercel Cron (hourly)  →  /api/scrape                      │
│    ├── Lambda Labs API  (public)                           │
│    ├── Azure Retail Prices API  (public)                   │
│    ├── Vast.ai API  (public)                               │
│    └── RunPod GraphQL API  (public)                        │
│                                                             │
│  You (manually) → POST /api/update                         │
│    ├── AWS (p5)                                             │
│    ├── Google Cloud (a3)                                    │
│    ├── CoreWeave, Crusoe, Voltage Park, etc.               │
│                                                             │
│  Both write to  →  Supabase (Postgres)                     │
│    ├── providers              (reference data)             │
│    ├── price_snapshots        (every scrape, forever)      │
│    └── icx_rate_history       (ICX trimmed mean, hourly)   │
│                                                             │
│  Frontend (index.html) reads from Supabase via anon key    │
└────────────────────────────────────────────────────────────┘
```

---

## Step 1 — Create a Supabase Project

1. Go to https://supabase.com and sign in (free tier is fine).
2. Click **New Project**, name it `icx-site`, choose a region close to your users.
3. Save the **database password** somewhere safe.
4. Once created, go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon (public) key** — safe to expose in the browser
   - **service_role (secret) key** — NEVER expose this in the browser

---

## Step 2 — Run the Database Schema

1. In Supabase, go to **SQL Editor → New query**.
2. Paste the contents of `schema.sql` and click **Run**.
3. This creates the tables, indexes, the `latest_prices` view, RLS policies, and seeds the 14 provider rows.

---

## Step 3 — Deploy to Vercel

### 3a. Connect your GitHub repo to Vercel

1. Go to https://vercel.com → **Add New Project**.
2. Import `sambefarmin/icx-site` from GitHub.
3. Vercel will auto-detect it as a static site — that's fine; the `api/` folder is automatically treated as serverless functions.
4. Click **Deploy** (first deploy will work even without environment variables set yet).

### 3b. Set Environment Variables

In Vercel → your project → **Settings → Environment Variables**, add:

| Variable | Value | Where |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | All environments |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service_role key | All environments |
| `CRON_SECRET` | Any long random string (e.g. from https://1password.com/password-generator/) | All environments |
| `ADMIN_SECRET` | Another long random string | All environments |

After adding variables, **redeploy** (Vercel → Deployments → Redeploy).

### 3c. Verify the Cron Is Registered

In Vercel → your project → **Settings → Crons** you should see `/api/scrape` scheduled to run `0 * * * *` (every hour on the hour).

---

## Step 4 — Seed Initial Prices (Manual)

Automated scrapers will populate Lambda Labs, Azure, Vast.ai, and RunPod on the next cron run (or when you trigger it manually). For the other providers, submit their current prices manually:

```bash
# Replace YOUR_VERCEL_URL and YOUR_ADMIN_SECRET below

curl -X POST https://YOUR_VERCEL_URL/api/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -d '{"providerName": "AWS (p5)", "priceUsd": 8.22}'

curl -X POST https://YOUR_VERCEL_URL/api/update \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"providerName": "Google Cloud (a3)", "priceUsd": 3.76}'

curl -X POST https://YOUR_VERCEL_URL/api/update \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"providerName": "CoreWeave", "priceUsd": 2.79}'

# ... repeat for Crusoe, Voltage Park, Prime Intellect, Hyperstack,
#     Novita AI, DataCrunch, TensorDock
```

Or trigger the automated scrapers immediately (no waiting for the cron):
```bash
curl "https://YOUR_VERCEL_URL/api/scrape?secret=YOUR_CRON_SECRET"
```

---

## Step 5 — Update index.html

Open `index.html` and make two changes:

### 5a. Add Supabase CDN (in `<head>`, before your closing `</head>`)
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

### 5b. Replace the simulated JS block

Find the block that starts with:
```javascript
const providers = [
  {name:"AWS (p5)",tier:"Hyperscaler",...
```
…and ends with the closing `}, 5000);` of the `setInterval` call.

Replace that entire block with the contents of `index-patch.js`, filling in your real values:
```javascript
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Also make sure the SVG chart element has these IDs for the patch to find them:
- `id="price-chart"` on the `<svg>` element
- `id="chart-line"` on the line `<path>`
- `id="chart-area"` on the gradient-fill `<path>`

---

## Step 6 — Push & Go Live

```bash
git add .
git commit -m "feat: real spot prices via Supabase + Vercel"
git push
```

Vercel will auto-deploy. Your site is now live with real prices.

---

## Ongoing Price Maintenance

### Automated (runs every hour via cron):
- Lambda Labs
- Azure (NC H100)
- Vast.ai
- RunPod

### Manual updates (whenever prices change — typically weekly):
- AWS (p5)
- Google Cloud (a3)
- CoreWeave, Crusoe, Voltage Park, Prime Intellect, Hyperstack
- Novita AI, DataCrunch, TensorDock

Use the curl commands from Step 4, or build a simple admin UI later.

---

## Environment Variables Reference

| Variable | Used By | Purpose |
|---|---|---|
| `SUPABASE_URL` | `lib/supabase.js` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase.js` | Write access to DB (server-side only) |
| `CRON_SECRET` | `api/scrape.js` | Protects the scrape endpoint from unauthorized calls |
| `ADMIN_SECRET` | `api/update.js` | Protects the manual price update endpoint |

---

## File Structure

```
icx-site/
├── index.html              ← updated to read from Supabase
├── index-patch.js          ← the JS snippet to paste into index.html
├── vercel.json             ← cron schedule + CORS headers
├── package.json            ← @supabase/supabase-js dependency
├── schema.sql              ← paste into Supabase SQL Editor
├── SETUP.md                ← this file
├── api/
│   ├── scrape.js           ← Vercel Cron: runs all scrapers hourly
│   ├── prices.js           ← GET latest prices
│   ├── history.js          ← GET ICX rate history
│   └── update.js           ← POST manual price update (auth required)
└── lib/
    ├── supabase.js         ← Supabase client (server-side)
    ├── icx.js              ← trimmed-mean ICX calculation
    └── scrapers.js         ← Lambda Labs, Azure, Vast.ai, RunPod scrapers
```

---

## Troubleshooting

**Cron isn't running:** Check Vercel → Settings → Crons. Crons only run on Vercel Pro+ plans. On Hobby (free), you can trigger manually with the `?secret=` URL.

**RLS errors:** Make sure you ran the full `schema.sql` including the `CREATE POLICY` statements.

**No data showing on site:** Open browser devtools → Console. Check for Supabase errors. Confirm the `SUPABASE_URL` and `SUPABASE_ANON_KEY` are correct in `index.html`.

**Provider not found in /api/update:** The provider name must exactly match the `name` column in the `providers` table (case-sensitive). Check your Supabase table or rerun the seed INSERT from `schema.sql`.
