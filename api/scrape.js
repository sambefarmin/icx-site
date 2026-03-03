/**
 * /api/scrape  – Vercel Cron Function
 * Runs every hour (configured in vercel.json).
 * Fetches prices from all automated scrapers in PARALLEL, stores snapshots,
 * and records the new ICX rate.
 *
 * Also callable manually:
 *   GET /api/scrape?secret=YOUR_CRON_SECRET
 *
 * ICX Rate methodology:
 *  - Only H100 SXM5 80GB (NVLink) providers included. PCIe excluded.
 *  - Only is_available = true providers counted.
 *  - Minimum panel of 8 SXM5 providers required to publish a rate.
 *  - Trimmed mean: drop bottom and top 15%, average the rest.
 */

import { supabase }    from '../lib/supabase.js';
import { SCRAPERS }    from '../lib/scrapers.js';
import { calcICXRate } from '../lib/icx.js';

export const config = { maxDuration: 60 };

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

    // 3. Run ALL scrapers in parallel — each has its own 10s internal timeout.
    //    Total wall-clock time ≈ slowest individual scraper, not sum of all.
    const jobs = toScrape.map(provider =>
      SCRAPERS[provider.name]()
        .then(scraped => ({ provider, scraped, err: null }))
        .catch(err    => ({ provider, scraped: null, err: err.message }))
    );
    const settled = await Promise.allSettled(jobs);

    const results = { scraped: [], skipped, errors: [] };

    // 4. Collect results and batch-insert snapshots
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
        raw_data:     scraped.rawData ?? null,
      });
      results.scraped.push({ provider: provider.name, price: scraped.price, gpuType });
    }

    // Batch insert all successful snapshots in one Supabase call
    if (inserts.length > 0) {
      const { error: insertErr } = await supabase.from('price_snapshots').insert(inserts);
      if (insertErr) {
        console.error('[/api/scrape] Batch insert error:', insertErr.message);
        // Move successful scrapes to errors so caller knows
        results.errors.push({ provider: 'batch-insert', reason: insertErr.message });
      }
    }

    // 5. Compute ICX rate from latest prices
    const { data: latestPrices, error: lpErr } = await supabase
      .from('latest_prices')
      .select('*');

    if (lpErr) throw lpErr;

    const sxm5Prices = latestPrices
      .filter(r => {
        if (!r.is_available) return false;
        if (r.gpu_type === 'H100 PCIe 80GB') return false;
        if (r.gpu_variant === 'PCIe') return false;
        return true;
      })
      .map(r => parseFloat(r.price_usd));

    const icx = calcICXRate(sxm5Prices);

    if (icx) {
      await supabase.from('icx_rate_history').insert({
        rate:           icx.rate,
        provider_count: icx.providerCount,
        min_price:      icx.minPrice,
        max_price:      icx.maxPrice,
      });
    }

    return res.status(200).json({
      ok:        true,
      icxRate:   icx?.rate ?? null,
      panelSize: sxm5Prices.length,
      panelMet:  icx !== null,
      timestamp: new Date().toISOString(),
      results,
    });

  } catch (err) {
    console.error('[/api/scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
