/**
 * /api/scrape  – Vercel Cron Function
 * Runs every hour (configured in vercel.json).
 * Fetches prices from all automated scrapers in PARALLEL, stores snapshots,
 * and records updated ICX rates for each tracked index.
 *
 * Also callable manually:
 *   GET /api/scrape?secret=YOUR_CRON_SECRET
 *
 * ICX Indexes published:
 *  ─ ICX H100 SXM5  (NVLink, 80GB): primary flagship index
 *     Minimum panel: 8 available SXM5 providers
 *     Trim: drop bottom and top 15%, average the rest
 *
 *  ─ ICX H100 PCIe  (80GB): secondary index
 *     Minimum panel: 3 available PCIe providers
 *     Same trim methodology
 *
 *  Future indexes (A100, H200, L40S) use same methodology once enough
 *  providers are tracked — no code changes needed, just new scrapers.
 */

import { supabase }    from '../lib/supabase.js';
import { SCRAPERS }    from '../lib/scrapers.js';
import { calcICXRate } from '../lib/icx.js';

export const config = { maxDuration: 60 };

// Minimum panels per GPU type
const MIN_PANELS = {
  'H100 SXM5 80GB': 8,
  'H100 PCIe 80GB': 3,
  default:          3,
};

export default async function handler(req, res) {
  const secret      = process.env.CRON_SECRET;
  const authHeader  = req.headers['authorization'] ?? '';
  const querySecret = req.query.secret ?? '';

  if (secret && authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Load all active providers
    const { data: providers, error: provErr } = await supabase
      .from('providers')
      .select('*')
      .eq('is_active', true);

    if (provErr) throw provErr;

    // 2. Split into scraped vs skipped
    const toScrape = providers.filter(p => SCRAPERS[p.name]);
    const skipped  = providers.filter(p => !SCRAPERS[p.name]).map(p => p.name);

    // 3. Run ALL scrapers in parallel — each has its own 10-12s internal timeout.
    //    Total wall-clock time ≈ slowest individual scraper, not sum of all.
    const jobs = toScrape.map(provider =>
      SCRAPERS[provider.name]()
        .then(scraped => ({ provider, scraped, err: null }))
        .catch(err    => ({ provider, scraped: null, err: err.message }))
    );
    const settled = await Promise.allSettled(jobs);

    const results = { scraped: [], skipped, errors: [] };

    // 4. Collect results and build batch-insert list
    const inserts = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') continue; // shouldn't happen — scrapers catch internally
      const { provider, scraped, err } = outcome.value;

      if (err || !scraped) {
        results.errors.push({ provider: provider.name, reason: err ?? 'Scraper returned null' });
        continue;
      }

      const gpuType = provider.gpu_variant === 'PCIe'
        ? 'H100 PCIe 80GB'
        : 'H100 SXM5 80GB';

      inserts.push({
        provider_id:  provider.id,
        price_usd:    scraped.price,
        is_available: scraped.isAvailable,
        gpu_type:     gpuType,
        pricing_model: provider.tier === 'Marketplace' ? 'spot' : 'on_demand',
        raw_data:     scraped.rawData ?? null,
      });
      results.scraped.push({ provider: provider.name, price: scraped.price, gpuType });
    }

    // Batch insert all successful snapshots in one Supabase call
    if (inserts.length > 0) {
      const { error: insertErr } = await supabase.from('price_snapshots').insert(inserts);
      if (insertErr) {
        console.error('[/api/scrape] Batch insert error:', insertErr.message);
        results.errors.push({ provider: 'batch-insert', reason: insertErr.message });
      }
    }

    // 5. Compute ICX rates from latest prices for every tracked GPU type
    const { data: latestPrices, error: lpErr } = await supabase
      .from('latest_prices')
      .select('*');

    if (lpErr) throw lpErr;

    // Group available prices by gpu_type
    const pricesByGpu = {};
    for (const row of (latestPrices || [])) {
      if (!row.is_available) continue;
      const gt = row.gpu_type || 'H100 SXM5 80GB';
      if (!pricesByGpu[gt]) pricesByGpu[gt] = [];
      pricesByGpu[gt].push(parseFloat(row.price_usd));
    }

    // Compute and store a rate for every GPU type that has enough data
    const icxResults = {};
    const rateInserts = [];

    for (const [gpuType, prices] of Object.entries(pricesByGpu)) {
      const minPanel = MIN_PANELS[gpuType] ?? MIN_PANELS.default;
      const icx = calcICXRate(prices, minPanel);
      icxResults[gpuType] = icx;

      if (icx) {
        rateInserts.push({
          rate:           icx.rate,
          provider_count: icx.providerCount,
          min_price:      icx.minPrice,
          max_price:      icx.maxPrice,
          gpu_type:       gpuType,
        });
      }
    }

    if (rateInserts.length > 0) {
      const { error: rateErr } = await supabase
        .from('icx_rate_history')
        .insert(rateInserts);
      if (rateErr) {
        console.error('[/api/scrape] Rate insert error:', rateErr.message);
      }
    }

    // Primary index (H100 SXM5) summary for response
    const primaryIcx = icxResults['H100 SXM5 80GB'];
    const pcieIcx    = icxResults['H100 PCIe 80GB'];

    return res.status(200).json({
      ok:            true,
      icxRate:       primaryIcx?.rate ?? null,
      icxRatePcie:   pcieIcx?.rate ?? null,
      panelSize:     primaryIcx?.panelSize ?? (pricesByGpu['H100 SXM5 80GB']?.length ?? 0),
      panelMet:      primaryIcx !== null && primaryIcx !== undefined,
      indexes:       Object.fromEntries(
        Object.entries(icxResults).map(([gpu, r]) => [gpu, r ? { rate: r.rate, panel: r.panelSize } : null])
      ),
      timestamp:     new Date().toISOString(),
      results,
    });

  } catch (err) {
    console.error('[/api/scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
