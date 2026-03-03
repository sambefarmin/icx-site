/**
 * POST /api/update
 * Manually submit a price for a provider that doesn't have a public API.
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
 * gpu_type is set automatically from the provider's gpu_variant column.
 * After inserting, recomputes the ICX H100 SXM5 rate using available
 * SXM5 providers only, with minimum panel enforcement (8 providers).
 */

import { supabase }    from '../lib/supabase.js';
import { calcICXRate } from '../lib/icx.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

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
    // Look up provider — select(*) so we don't fail if gpu_variant column
    // doesn't exist yet (pending migration runs gracefully)
    const { data: prov, error: provErr } = await supabase
      .from('providers')
      .select('*')
      .eq('name', providerName)
      .eq('is_active', true)
      .single();

    if (provErr || !prov) {
      return res.status(404).json({ error: `Provider "${providerName}" not found` });
    }

    // Set gpu_type automatically from the provider's variant
    const gpuType = prov.gpu_variant === 'PCIe'
      ? 'H100 PCIe 80GB'
      : 'H100 SXM5 80GB';

    // Insert price snapshot
    const { error: insertErr } = await supabase
      .from('price_snapshots')
      .insert({
        provider_id:  prov.id,
        price_usd:    priceUsd,
        is_available: isAvailable,
        gpu_type:     gpuType,
        region:       region,
      });

    if (insertErr) throw insertErr;

    // Recompute ICX H100 SXM5 rate — SXM5 + available only.
    // Accept both 'H100 SXM5 80GB' and legacy 'H100 80GB' so rate works before
    // and after the gpu_type normalization migration runs.
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

    // Returns null if panel < 8
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
      provider:  prov.name,
      gpuType,
      price:     priceUsd,
      icxRate:   icx?.rate ?? null,
      panelSize: sxm5Prices.length,
      panelMet:  icx !== null,
    });

  } catch (err) {
    console.error('[/api/update] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
