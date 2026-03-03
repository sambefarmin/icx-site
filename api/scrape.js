/**
 * /api/scrape  – Vercel Cron Function
 * Runs every hour (configured in vercel.json).
 * Fetches prices from all automated scrapers in PARALLEL, stores snapshots,
 * and records updated ICX rates for each tracked index.
 *
 * Also callable manually:
 *   GET /api/scrape?secret=YOUR_CRON_SECRET
 *
 * Validation pipeline (3 layers applied before DB insert):
 *   1. Bounds check  — per-GPU-type min/max range
 *   2. Delta check   — vs provider's last known price (>60% swing → flagged)
 *   3. IQR outlier   — statistical outlier across the current panel
 *
 * Flagged prices are inserted to the DB for audit but excluded
 * from the ICX rate calculation.
 *
 * ICX Indexes published:
 *  ─ ICX H100 SXM5  (NVLink, 80GB): primary flagship index
 *  ─ ICX H100 PCIe  (80GB): secondary index
 */

import { supabase }        from '../lib/supabase.js';
import { SCRAPERS }        from '../lib/scrapers.js';
import { calcICXRate }     from '../lib/icx.js';
import { boundsCheck, deltaCheck, panelOutlierCheck } from '../lib/validate.js';

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

    // 2. Fetch each provider's LAST known price for delta check
    //    (do this BEFORE scraping so we compare new vs prior)
    const { data: prevPriceRows } = await supabase
      .from('latest_prices')
      .select('provider_id, price_usd');
    const prevMap = {};
    for (const r of (prevPriceRows || [])) {
      prevMap[r.provider_id] = parseFloat(r.price_usd);
    }

    // 3. Split into scraped vs skipped
    const toScrape = providers.filter(p => SCRAPERS[p.name]);
    const skipped  = providers.filter(p => !SCRAPERS[p.name]).map(p => p.name);

    // 4. Run ALL scrapers in parallel — each has its own 10-12s internal timeout.
    const jobs = toScrape.map(provider =>
      SCRAPERS[provider.name]()
        .then(scraped => ({ provider, scraped, err: null }))
        .catch(err    => ({ provider, scraped: null, err: err.message }))
    );
    const settled = await Promise.allSettled(jobs);

    const results = { scraped: [], skipped, errors: [], flagged: [] };

    // 5. Collect results — apply bounds + delta checks immediately
    //    IQR check comes later (needs full panel assembled first)
    const candidates = []; // { provider, scraped, gpuType, flags[] }

    for (const outcome of settled) {
      if (outcome.status === 'rejected') continue;
      const { provider, scraped, err } = outcome.value;

      if (err || !scraped) {
        results.errors.push({ provider: provider.name, reason: err ?? 'Scraper returned null' });
        continue;
      }

      const gpuType = provider.gpu_variant === 'PCIe'
        ? 'H100 PCIe 80GB'
        : 'H100 SXM5 80GB';

      const flags = [];

      // Layer 1 — Bounds
      const bCheck = boundsCheck(scraped.price, gpuType);
      if (!bCheck.valid) flags.push(bCheck.flag);

      // Layer 2 — Delta vs previous price
      const prevPrice = prevMap[provider.id] ?? null;
      const dCheck = deltaCheck(scraped.price, prevPrice);
      if (!dCheck.valid) flags.push(dCheck.flag);

      candidates.push({ provider, scraped, gpuType, flags, prevPrice });
    }

    // 6. Layer 3 — IQR outlier check (needs full panel per gpu_type)
    //    Build per-gpu_type price arrays from candidates that passed layers 1+2
    const cleanPanels = {};
    for (const c of candidates) {
      if (c.flags.length === 0) { // only use already-clean prices to build the reference panel
        if (!cleanPanels[c.gpuType]) cleanPanels[c.gpuType] = [];
        cleanPanels[c.gpuType].push(c.scraped.price);
      }
    }

    for (const c of candidates) {
      const panel = cleanPanels[c.gpuType] ?? [];
      const iqrCheck = panelOutlierCheck(c.scraped.price, panel);
      if (!iqrCheck.valid) c.flags.push(iqrCheck.flag);
    }

    // 7. Build DB insert list with validation flags
    const inserts = [];
    for (const c of candidates) {
      const isFlagged = c.flags.length > 0;

      inserts.push({
        provider_id:      c.provider.id,
        price_usd:        c.scraped.price,
        is_available:     c.scraped.isAvailable,
        gpu_type:         c.gpuType,
        pricing_model:    c.provider.tier === 'Marketplace' ? 'spot' : 'on_demand',
        raw_data:         c.scraped.rawData ?? null,
        is_flagged:       isFlagged,
        validation_flags: c.flags,
      });

      if (isFlagged) {
        results.flagged.push({
          provider: c.provider.name,
          price:    c.scraped.price,
          gpuType:  c.gpuType,
          flags:    c.flags,
        });
      } else {
        results.scraped.push({ provider: c.provider.name, price: c.scraped.price, gpuType: c.gpuType });
      }
    }

    // Batch insert all snapshots (clean + flagged both stored for audit trail)
    if (inserts.length > 0) {
      const { error: insertErr } = await supabase.from('price_snapshots').insert(inserts);
      if (insertErr) {
        console.error('[/api/scrape] Batch insert error:', insertErr.message);
        results.errors.push({ provider: 'batch-insert', reason: insertErr.message });
      }
    }

    // 8. Compute ICX rates — exclude flagged prices
    const { data: latestPrices, error: lpErr } = await supabase
      .from('latest_prices')
      .select('*');

    if (lpErr) throw lpErr;

    // Group CLEAN, available prices by gpu_type
    const pricesByGpu = {};
    for (const row of (latestPrices || [])) {
      if (!row.is_available) continue;
      if (row.is_flagged)    continue; // exclude validated-out prices from index calc
      const gt = row.gpu_type || 'H100 SXM5 80GB';
      if (!pricesByGpu[gt]) pricesByGpu[gt] = [];
      pricesByGpu[gt].push(parseFloat(row.price_usd));
    }

    // Compute and store a rate for every GPU type with enough data
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

    // Build response
    const primaryIcx = icxResults['H100 SXM5 80GB'];
    const pcieIcx    = icxResults['H100 PCIe 80GB'];

    const validationSummary = {
      total:   inserts.length,
      clean:   results.scraped.length,
      flagged: results.flagged.length,
      flagRate: inserts.length > 0
        ? ((results.flagged.length / inserts.length) * 100).toFixed(1) + '%'
        : '0%',
      details: results.flagged,
    };

    return res.status(200).json({
      ok:            true,
      icxRate:       primaryIcx?.rate ?? null,
      icxRatePcie:   pcieIcx?.rate ?? null,
      panelSize:     primaryIcx?.panelSize ?? (pricesByGpu['H100 SXM5 80GB']?.length ?? 0),
      panelMet:      primaryIcx !== null && primaryIcx !== undefined,
      indexes:       Object.fromEntries(
        Object.entries(icxResults).map(([gpu, r]) => [gpu, r ? { rate: r.rate, panel: r.panelSize } : null])
      ),
      validation:    validationSummary,
      timestamp:     new Date().toISOString(),
      results,
    });

  } catch (err) {
    console.error('[/api/scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
