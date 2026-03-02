/**
 * GET /api/prices
 * Returns the latest price for every active provider,
 * plus the current ICX rate.
 *
 * Response shape:
 * {
 *   icxRate: 2.68,
 *   updatedAt: "2025-01-01T12:00:00Z",
 *   providers: [
 *     { name, tier, tierClass, config, price, isAvailable, scrapedAt },
 *     ...
 *   ]
 * }
 */

import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  try {
    // Fetch latest prices view
    const { data: prices, error: priceErr } = await supabase
      .from('latest_prices')
      .select('name, tier, tier_class, config, price_usd, is_available, scraped_at');

    if (priceErr) throw priceErr;

    // Fetch the most recent ICX rate
    const { data: icxRows, error: icxErr } = await supabase
      .from('icx_rate_history')
      .select('rate, computed_at')
      .order('computed_at', { ascending: false })
      .limit(1);

    if (icxErr) throw icxErr;

    const icxRate   = icxRows?.[0]?.rate    ?? null;
    const updatedAt = icxRows?.[0]?.computed_at ?? null;

    const providers = prices.map(r => ({
      name:        r.name,
      tier:        r.tier,
      tierClass:   r.tier_class,
      config:      r.config,
      price:       parseFloat(r.price_usd),
      isAvailable: r.is_available,
      scrapedAt:   r.scraped_at,
    }));

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ icxRate, updatedAt, providers });

  } catch (err) {
    console.error('[/api/prices] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
