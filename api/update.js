/**
 * POST /api/update
 * Manually submit a price for a provider that doesn't have a public API
 * (AWS, GCP, CoreWeave, Crusoe, Voltage Park, etc.).
 *
 * Auth: Bearer token matching ADMIN_SECRET env var.
 *
 * Request body (JSON):
 * {
 *   providerName: "AWS (p5)",
 *   priceUsd:     8.22,
 *   isAvailable:  true,       // optional, default true
 *   region:       "us-east-1" // optional
 * }
 *
 * After inserting, recomputes and stores the ICX rate.
 */

import { supabase }    from '../lib/supabase.js';
import { calcICXRate } from '../lib/icx.js';

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Auth check
  const secret     = process.env.ADMIN_SECRET;
  const authHeader = req.headers['authorization'] ?? '';
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { providerName, priceUsd, isAvailable = true, region = null } = req.body ?? {};

  if (!providerName || priceUsd == null) {
    return res.status(400).json({ error: 'providerName and priceUsd are required' });
  }
  if (isNaN(priceUsd) || priceUsd <= 0) {
    return res.status(400).json({ error: 'priceUsd must be a positive number' });
  }

  try {
    // Look up provider ID
    const { data: prov, error: provErr } = await supabase
      .from('providers')
      .select('id, name')
      .eq('name', providerName)
      .eq('is_active', true)
      .single();

    if (provErr || !prov) {
      return res.status(404).json({ error: `Provider "${providerName}" not found` });
    }

    // Insert price snapshot
    const { error: insertErr } = await supabase
      .from('price_snapshots')
      .insert({
        provider_id:  prov.id,
        price_usd:    priceUsd,
        is_available: isAvailable,
        gpu_type:     'H100 SXM5 80GB',
        region:       region,
      });

    if (insertErr) throw insertErr;

    // Recompute ICX rate from latest prices
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
      ok:       true,
      provider: prov.name,
      price:    priceUsd,
      icxRate:  icx?.rate ?? null,
    });

  } catch (err) {
    console.error('[/api/update] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
