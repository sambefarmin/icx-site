/**
 * ICX Rate Calculation
 *
 * Trimmed mean: remove bottom 15% and top 15% of prices, average the rest.
 * Requires a minimum panel of MIN_PANEL available SXM5 providers — returns
 * null if unmet so a rate is never published on thin data.
 *
 * Callers must pre-filter to the target GPU variant (H100 SXM5 80GB for the
 * primary index) and to is_available = true before passing prices in.
 */

const MIN_PANEL = 8; // minimum available SXM5 providers required to publish

export function calcICXRate(prices) {
  if (!prices || prices.length === 0) return null;

  if (prices.length < MIN_PANEL) {
    console.warn(`[ICX] Insufficient panel: ${prices.length} < minimum ${MIN_PANEL}. Rate not published.`);
    return null;
  }

  const sorted  = [...prices].sort((a, b) => a - b);
  const trim    = Math.floor(sorted.length * 0.15);
  const trimmed = sorted.slice(trim, sorted.length - trim);

  if (trimmed.length === 0) return null;

  const rate = trimmed.reduce((sum, p) => sum + p, 0) / trimmed.length;

  return {
    rate:          Math.round(rate * 10000) / 10000,
    providerCount: trimmed.length,   // providers in the trimmed set
    panelSize:     prices.length,    // total available SXM5 providers before trimming
    minPrice:      sorted[0],
    maxPrice:      sorted[sorted.length - 1],
  };
}
