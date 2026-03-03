// ═══════════════════════════════════════════════════════════════
// ICX Data Validation
// Multi-layer accuracy checks applied to every scraped price
// before it enters the database or ICX rate calculation.
//
// Layers (applied in order):
//   1. Bounds check   — per-GPU-type min/max sanity range
//   2. Delta check    — vs provider's last known price
//   3. IQR outlier    — statistical outlier across current panel
// ═══════════════════════════════════════════════════════════════

// ── Price bounds per GPU type ────────────────────────────────────
// Tighter than the HTML parser catch-all ($0.50–$25).
// SXM5 floor set above the PCIe ceiling to catch GPU type mismatches.
const BOUNDS = {
  'H100 SXM5 80GB': { min: 1.20, max: 9.00 },
  'H100 PCIe 80GB': { min: 0.60, max: 6.00 },
};
const BOUNDS_DEFAULT = { min: 0.50, max: 25.00 };

// ── Layer 1: Bounds check ────────────────────────────────────────
// Returns { valid: bool, flag: string|null }
export function boundsCheck(price, gpuType) {
  const { min, max } = BOUNDS[gpuType] || BOUNDS_DEFAULT;
  if (price < min) {
    return { valid: false, flag: `BELOW_MIN:$${price.toFixed(4)}<$${min}` };
  }
  if (price > max) {
    return { valid: false, flag: `ABOVE_MAX:$${price.toFixed(4)}>$${max}` };
  }
  return { valid: true, flag: null };
}

// ── Layer 2: Delta check ─────────────────────────────────────────
// Flags if the new price deviates more than DELTA_THRESHOLD
// from the provider's last known price.
// Catches: scraper suddenly pulling wrong product/page.
const DELTA_THRESHOLD = 0.60; // 60%

export function deltaCheck(price, prevPrice) {
  if (!prevPrice || prevPrice <= 0) return { valid: true, flag: null }; // no history → skip
  const delta = Math.abs(price - prevPrice) / prevPrice;
  if (delta > DELTA_THRESHOLD) {
    const pct = (delta * 100).toFixed(0);
    return {
      valid: false,
      flag: `LARGE_DELTA:${pct}%_change_from_$${prevPrice.toFixed(4)}`,
    };
  }
  return { valid: true, flag: null };
}

// ── Layer 3: IQR panel outlier ───────────────────────────────────
// Flags a price that is a statistical outlier relative to the
// current panel (all scraped prices for the same gpu_type).
// Uses IQR with a multiplier of 2.5 (conservative — only flags
// extreme outliers, not just expensive/cheap providers).
const IQR_MULTIPLIER = 2.5;

export function panelOutlierCheck(price, allPrices) {
  if (!allPrices || allPrices.length < 4) return { valid: true, flag: null }; // need enough data
  const sorted = [...allPrices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return { valid: true, flag: null }; // degenerate panel
  const lo = q1 - IQR_MULTIPLIER * iqr;
  const hi = q3 + IQR_MULTIPLIER * iqr;
  if (price < lo) {
    return { valid: false, flag: `IQR_LOW:$${price.toFixed(4)}<$${lo.toFixed(4)}` };
  }
  if (price > hi) {
    return { valid: false, flag: `IQR_HIGH:$${price.toFixed(4)}>$${hi.toFixed(4)}` };
  }
  return { valid: true, flag: null };
}

// ── Combined validator ────────────────────────────────────────────
// Runs all applicable layers. IQR check is optional (pass null
// to skip when the full panel isn't assembled yet).
//
// Returns { valid: bool, flags: string[] }
export function runValidation(price, gpuType, prevPrice = null, allPrices = null) {
  const flags = [];

  const b = boundsCheck(price, gpuType);
  if (!b.valid) flags.push(b.flag);

  const d = deltaCheck(price, prevPrice);
  if (!d.valid) flags.push(d.flag);

  if (allPrices !== null) {
    const iqr = panelOutlierCheck(price, allPrices);
    if (!iqr.valid) flags.push(iqr.flag);
  }

  return { valid: flags.length === 0, flags };
}
