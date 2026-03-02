/**
 * ICX SITE – FRONTEND DATA PATCH
 * ═══════════════════════════════════════════════════════════════════
 * Replace the simulated price block in your index.html with this
 * script block.  Add the Supabase CDN import just before it.
 *
 * STEP 1 – Add Supabase CDN near the top of your <head>:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 *
 * STEP 2 – Replace everything from:
 *   "const providers = [..."  through the closing setInterval block
 *   with the contents of this file (wrapped in a <script> tag).
 *
 * STEP 3 – Fill in YOUR Supabase project URL and anon key below.
 *   The anon key is safe to embed here because we use Row Level Security
 *   (read-only access for anonymous users).
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── CONFIG – fill these in ──────────────────────────────────────
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';   // ← replace
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';                       // ← replace
const POLL_INTERVAL_MS  = 5 * 60 * 1000; // refresh every 5 min
// ─────────────────────────────────────────────────────────────────

const { createClient } = supabase; // from CDN
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ─────────────────────────────────────────────────────────
let providers   = [];   // current price data for all providers
let icxRate     = null; // current ICX rate
let chartPoints = [];   // 30-day history for the chart

// ── ICX Rate (trimmed mean) ───────────────────────────────────────
// Kept client-side for compatibility, but the authoritative value
// is now pre-computed server-side and served from icx_rate_history.
function calcICX(priceList) {
  const s = [...priceList].sort((a, b) => a - b);
  const t = Math.floor(s.length * 0.15);
  const tr = s.slice(t, s.length - t);
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
}

// ── Fetch current prices from Supabase ───────────────────────────
async function fetchPrices() {
  const { data, error } = await db
    .from('latest_prices')
    .select('name, tier, tier_class, config, price_usd, is_available, scraped_at');

  if (error) {
    console.error('[ICX] fetchPrices error:', error.message);
    return;
  }

  providers = data.map(r => ({
    name:    r.name,
    tier:    r.tier,
    tierCls: r.tier_class,
    config:  r.config,
    price:   parseFloat(r.price_usd),
    avail:   r.is_available,
  }));

  // Use server-computed ICX rate (most recent row)
  const { data: icxRows } = await db
    .from('icx_rate_history')
    .select('rate')
    .order('computed_at', { ascending: false })
    .limit(1);

  icxRate = icxRows?.[0]?.rate ? parseFloat(icxRows[0].rate) : calcICX(providers.map(p => p.price));

  renderAll();
}

// ── Fetch 30-day chart history ────────────────────────────────────
async function fetchHistory() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('icx_rate_history')
    .select('rate, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true });

  if (error) {
    console.error('[ICX] fetchHistory error:', error.message);
    return;
  }

  chartPoints = data.map(r => parseFloat(r.rate));

  // If we don't have enough history yet, pad with the current rate
  if (chartPoints.length < 2 && icxRate) {
    chartPoints = [icxRate];
  }

  drawChart(chartPoints);
}

// ── Render helpers ────────────────────────────────────────────────
// These mirror the existing render functions in your index.html.
// If your functions are named differently, update the calls below.

function renderAll() {
  renderStats();
  renderTable();
  renderTicker();
}

function renderStats() {
  if (icxRate == null) return;
  const rateEl = document.getElementById('ref-rate');
  if (rateEl) rateEl.textContent = icxRate.toFixed(2);

  const countEl = document.getElementById('prov-count');
  if (countEl) countEl.textContent = providers.filter(p => p.avail).length;
}

// renderTable and renderTicker keep the same logic as the original
// site – they iterate over `providers` which is now live data.
// If your existing renderTable() / renderTicker() read from the global
// `providers` variable, they will work unchanged after this patch.
// Just make sure they reference the module-level `providers` above.

// ── Chart ─────────────────────────────────────────────────────────
// drawChart is a renamed copy of the original chart logic.
// Replace the original chart generation block with this function
// and call drawChart(chartPoints) after fetchHistory().
function drawChart(pts) {
  const svg = document.getElementById('price-chart');
  if (!svg || pts.length < 2) return;

  const W = svg.viewBox.baseVal.width  || 800;
  const H = svg.viewBox.baseVal.height || 160;
  const pad = 10;

  const min = Math.min(...pts) - 0.1;
  const max = Math.max(...pts) + 0.1;
  const xStep = (W - pad * 2) / (pts.length - 1);

  const toX = i => pad + i * xStep;
  const toY = v => H - pad - ((v - min) / (max - min)) * (H - pad * 2);

  const pathD = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const areaD = pathD + ` L${toX(pts.length - 1).toFixed(1)},${H} L${pad},${H} Z`;

  const linePath = svg.querySelector('#chart-line') || svg.querySelector('path:first-of-type');
  const areaPath = svg.querySelector('#chart-area') || svg.querySelector('path:last-of-type');

  if (linePath) linePath.setAttribute('d', pathD);
  if (areaPath) areaPath.setAttribute('d', areaD);

  // Move current-price dot to last point
  const dot = svg.querySelector('circle');
  if (dot) {
    dot.setAttribute('cx', toX(pts.length - 1).toFixed(1));
    dot.setAttribute('cy', toY(pts[pts.length - 1]).toFixed(1));
  }
}

// ── Boot ──────────────────────────────────────────────────────────
async function init() {
  await fetchPrices();
  await fetchHistory();
  // Poll for fresh data every 5 minutes
  setInterval(async () => {
    await fetchPrices();
    await fetchHistory();
  }, POLL_INTERVAL_MS);
}

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
