/**
 * /api/scrape  – Vercel Cron Function
 * Runs every hour (configured in vercel.json).
 * Fetches prices from all automated scrapers, stores snapshots,
 * and records the new ICX rate.
 *
 * Also callable manually:
 *   GET /api/scrape?secret=YOUR_CRON_SECRET
 */

import { supabase }  from '../lib/supabase.js';
import { SCRAPERS }  from '../lib/scrapers.js';
import { calcICXRate } from '../lib/icx.js';

export const config = { maxDuration: 60 }; // allow up to 60s for all HTTP calls

export default async function handler(req, res) {
  // Guard: only Vercel cron calls or requests with the secret token
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] ?? '';
  const querySecret = req.query.secret ?? '';

  if (secret && authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Load all active providers from DB
    const { data: providers, error: provErr } = await supabase
      .from('providers')
      .select('id, name, source_type')
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

      const { error: insertErr } = await supabase
        .from('price_snapshots')
        .insert({
          provider_id:  provider.id,
          price_usd:    scraped.price,
          is_available: scraped.isAvailable,
          gpu_type:     'H100 SXM5 80GB',
          raw_data:     scraped.rawData ?? null,
        });

      if (insertErr) {
        results.errors.push({ provider: provider.name, reason: insertErr.message });
      } else {
        results.scraped.push({ provider: provider.name, price: scraped.price });
      }
    }

    // 3. Fetch latest price per provider to compute ICX rate
    const { data: latestPrices, error: lpErr } = await supabase
      .from('latest_prices')
      .select('price_usd, is_available');

    if (lpErr) throw lpErr;

    const availablePrices = latestPrices
      .filter(r => r.is_available)
      .map(r => parseFloat(r.price_usd));

    const icx = calcICXRate(availablePrices);

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
      timestamp: new Date().toISOString(),
      results,
    });

  } catch (err) {
    console.error('[/api/scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
