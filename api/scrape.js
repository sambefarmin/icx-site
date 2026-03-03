/**
 * /api/scrape  – Vercel Cron Function
 * Runs every hour (configured in vercel.json).
 * Fetches prices from all automated scrapers, stores snapshots,
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

export const config = { maxDuration: 60 }; // allow up to 60s for all HTTP calls

export default async function handler(req, res) {
  // Guard: only Vercel cron calls or requests with the secret token
  const secret      = process.env.CRON_SECRET;
  const authHeader  = req.headers['authorization'] ?? '';
  const querySecret = req.query.secret ?? '';

  if (secret && authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Load all active providers — select(*) so we don't fail if gpu_variant
    //    column doesn't exist yet (pending migration runs gracefully)
    const { data: providers, error: provErr } = await supabase
      .from('providers')
      .select('*')
      .eq('is_active', true);

    if (provErr) throw provErr;

    const results = { scraped: [], skipped: [], errors: [] };

    // 2. For each provider that has an automated scraper, fetch its price
    for (const provider of providers) {
      const scraperFn = SCRAPERS[provider.name];
      if (!scraperFn) {
        results.skipped.push(provider.name);
        continue;
      }

      const scraped = await scraperFn();
      if (!scraped) {
        results.errors.push({ provider: provider.name, reason: 'Scraper returned null' });
        continue;
      }

      // Tag snapshot with correct gpu_type based on provider variant
      const gpuType = provider.gpu_variant === 'PCIe'
        ? 'H100 PCIe 80GB'
        : 'H100 SXM5 80GB';

      const { error: insertErr } = await supabase
        .from('price_snapshots')
        .insert({
          provider_id:  provider.id,
          price_usd:    scraped.price,
          is_available: scraped.isAvailable,
          gpu_type:     gpuType,
          raw_data:     scraped.rawData ?? null,
        });

      if (insertErr) {
        results.errors.push({ provider: provider.name, reason: insertErr.message });
      } else {
        results.scraped.push({ provider: provider.name, price: scraped.price, gpuType });
      }
    }

    // 3. Fetch latest prices — filter to SXM5 + available only for ICX H100 SXM5 rate.
    //    Accept both 'H100 SXM5 80GB' and legacy 'H100 80GB' so rate works before
    //    and after the gpu_type normalization migration runs.
    const { data: latestPrices, error: lpErr } = await supabase
      .from('latest_prices')
      .select('price_usd, is_available, gpu_type, gpu_variant');

    if (lpErr) throw lpErr;

    const sxm5Prices = latestPrices
      .filter(r => {
        if (!r.is_available) return false;
        // Include if tagged as SXM5, legacy 'H100 80GB', or gpu_variant is not PCIe
        if (r.gpu_type === 'H100 PCIe 80GB') return false;
        if (r.gpu_variant === 'PCIe') return false;
        return true;
      })
      .map(r => parseFloat(r.price_usd));

    // calcICXRate returns null if panel < 8 (minimum requirement)
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
      ok:           true,
      icxRate:      icx?.rate ?? null,
      panelSize:    sxm5Prices.length,
      panelMet:     icx !== null,
      timestamp:    new Date().toISOString(),
      results,
    });

  } catch (err) {
    console.error('[/api/scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
