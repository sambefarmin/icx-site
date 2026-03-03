/**
 * /api/validate  – Data Quality Audit Endpoint
 *
 * Returns a validation report covering:
 *   - Current panel health (which providers are clean vs flagged)
 *   - 24h and 7d flag rates
 *   - Per-provider flag history
 *   - Overall data quality score
 *
 * Authentication: requires X-Admin-Secret header (or ?secret= query param)
 * matching the ADMIN_SECRET env var.
 *
 * Usage:
 *   GET /api/validate
 *   Authorization header: X-Admin-Secret: <ADMIN_SECRET>
 *   or: GET /api/validate?secret=<ADMIN_SECRET>
 */

import { supabase } from '../lib/supabase.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Auth check
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = req.headers['x-admin-secret'] ?? '';
  const querySecret  = req.query.secret ?? '';

  if (adminSecret && headerSecret !== adminSecret && querySecret !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now    = new Date();
    const h24ago = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const d7ago  = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();

    // ── 1. Current snapshot state per provider ──────────────────
    const { data: latest, error: latestErr } = await supabase
      .from('latest_prices')
      .select('provider_id, name, price_usd, gpu_type, is_flagged, validation_flags, scraped_at');

    if (latestErr) throw latestErr;

    const currentPanel = (latest || []).map(r => ({
      provider:         r.name,
      providerId:       r.provider_id,
      gpuType:          r.gpu_type,
      price:            parseFloat(r.price_usd),
      isFlagged:        r.is_flagged,
      validationFlags:  r.validation_flags ?? [],
      lastScraped:      r.scraped_at,
    }));

    const panelClean   = currentPanel.filter(p => !p.isFlagged);
    const panelFlagged = currentPanel.filter(p => p.isFlagged);

    // ── 2. 24h stats ────────────────────────────────────────────
    const { data: last24h, error: err24h } = await supabase
      .from('price_snapshots')
      .select('provider_id, price_usd, gpu_type, is_flagged, validation_flags, scraped_at')
      .gte('scraped_at', h24ago);

    if (err24h) throw err24h;

    const total24h   = (last24h || []).length;
    const flagged24h = (last24h || []).filter(r => r.is_flagged).length;

    // ── 3. 7d stats ──────────────────────────────────────────────
    const { data: last7d, error: err7d } = await supabase
      .from('price_snapshots')
      .select('provider_id, is_flagged, scraped_at')
      .gte('scraped_at', d7ago);

    if (err7d) throw err7d;

    const total7d   = (last7d || []).length;
    const flagged7d = (last7d || []).filter(r => r.is_flagged).length;

    // ── 4. Per-provider flag breakdown (24h) ────────────────────
    const providerFlagMap = {};
    for (const r of (last24h || [])) {
      if (!r.is_flagged) continue;
      if (!providerFlagMap[r.provider_id]) {
        providerFlagMap[r.provider_id] = {
          flagCount: 0,
          reasons:   {},
        };
      }
      providerFlagMap[r.provider_id].flagCount++;
      for (const flag of (r.validation_flags || [])) {
        const key = flag.split(':')[0]; // e.g. "BELOW_MIN", "LARGE_DELTA", "IQR_HIGH"
        providerFlagMap[r.provider_id].reasons[key] =
          (providerFlagMap[r.provider_id].reasons[key] ?? 0) + 1;
      }
    }

    // Attach provider names
    const providerHistory = Object.entries(providerFlagMap).map(([id, data]) => {
      const p = currentPanel.find(c => c.providerId === parseInt(id));
      return {
        provider:  p?.provider ?? `Provider #${id}`,
        flagCount: data.flagCount,
        reasons:   data.reasons,
      };
    }).sort((a, b) => b.flagCount - a.flagCount);

    // ── 5. Flag reason breakdown (24h) ──────────────────────────
    const reasonBreakdown = {};
    for (const r of (last24h || [])) {
      for (const flag of (r.validation_flags || [])) {
        const key = flag.split(':')[0];
        reasonBreakdown[key] = (reasonBreakdown[key] ?? 0) + 1;
      }
    }

    // ── 6. Quality score ─────────────────────────────────────────
    // 0–100 score: 100 = no flagged data, 0 = everything flagged
    const qualityScore24h = total24h > 0
      ? Math.round(((total24h - flagged24h) / total24h) * 100)
      : 100;

    return res.status(200).json({
      ok:          true,
      generatedAt: now.toISOString(),

      qualityScore: {
        score24h:   qualityScore24h,
        grade:      qualityScore24h >= 95 ? 'A'
                  : qualityScore24h >= 85 ? 'B'
                  : qualityScore24h >= 70 ? 'C'
                  : 'D',
        label:      qualityScore24h >= 95 ? 'Excellent'
                  : qualityScore24h >= 85 ? 'Good'
                  : qualityScore24h >= 70 ? 'Fair'
                  : 'Poor',
      },

      currentPanel: {
        total:         currentPanel.length,
        clean:         panelClean.length,
        flagged:       panelFlagged.length,
        cleanProviders:   panelClean.map(p => ({ provider: p.provider, gpuType: p.gpuType, price: p.price })),
        flaggedProviders: panelFlagged.map(p => ({
          provider:       p.provider,
          gpuType:        p.gpuType,
          price:          p.price,
          flags:          p.validationFlags,
        })),
      },

      last24h: {
        total:     total24h,
        clean:     total24h - flagged24h,
        flagged:   flagged24h,
        flagRate:  total24h > 0 ? ((flagged24h / total24h) * 100).toFixed(1) + '%' : '0%',
      },

      last7d: {
        total:     total7d,
        clean:     total7d - flagged7d,
        flagged:   flagged7d,
        flagRate:  total7d > 0 ? ((flagged7d / total7d) * 100).toFixed(1) + '%' : '0%',
      },

      flagReasons:     reasonBreakdown,
      providerHistory: providerHistory,
    });

  } catch (err) {
    console.error('[/api/validate] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
