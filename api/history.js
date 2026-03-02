/**
 * GET /api/history?days=30
 * Returns historical ICX rate data for the chart.
 *
 * Query params:
 *   days  – how many days of history (default: 30, max: 365)
 *
 * Response shape:
 * {
 *   history: [
 *     { rate: 2.68, computedAt: "2025-01-01T12:00:00Z" },
 *     ...
 *   ]
 * }
 */

import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days ?? '30', 10), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await supabase
      .from('icx_rate_history')
      .select('rate, computed_at')
      .gte('computed_at', since)
      .order('computed_at', { ascending: true });

    if (error) throw error;

    const history = rows.map(r => ({
      rate:       parseFloat(r.rate),
      computedAt: r.computed_at,
    }));

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ history });

  } catch (err) {
    console.error('[/api/history] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
