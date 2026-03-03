/**
 * ICX Rate Calculation
 *
 * Trimmed mean: remove bottom 15% and top 15% of prices, average the rest.
 * Requires a minimum panel of minPanel available providers — returns null if
 * unmet so a rate is never published on thin data.
 *
 * Callers must pre-filter to the target GPU variant and to is_available = true
 * before passing prices in.
 *
 * minPanel defaults:
 *  - H100 SXM5: 8  (liquid market, strict)
 *  - H100 PCIe:  3  (fewer providers, relaxed)
 *  - Other:      3  (emerging indexes, relaxed)
 */

const MIN_PANEL_DEFAULT = 8;

export function calcICXRate(prices, minPanel = MIN_PANEL_DEFAULT) {
  if (!prices || prices.length === 0) return null;

  if (prices.length < minPanel) {
    console.warn(`[ICX] Insufficient panel: ${prices.length} < minimum ${minPanel}. Rate not published.`);
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
    panelSize:     prices.length,    // total available providers before trimming
    minPrice:      sorted[0],
    maxPrice:      sorted[sorted.length - 1],
  };
}
