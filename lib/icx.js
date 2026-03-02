/**
 * ICX Rate Calculation
 * Trimmed mean: remove bottom 15% and top 15% of prices, average the rest.
 * This matches the methodology already on the site.
 */
export function calcICXRate(prices) {
  if (!prices || prices.length === 0) return null;

  const sorted = [...prices].sort((a, b) => a - b);
  const trim   = Math.floor(sorted.length * 0.15);
  const trimmed = sorted.slice(trim, sorted.length - trim);

  if (trimmed.length === 0) return null;

  const rate = trimmed.reduce((sum, p) => sum + p, 0) / trimmed.length;
  return {
    rate:           Math.round(rate * 10000) / 10000,
    providerCount:  trimmed.length,
    minPrice:       Math.min(...sorted),
    maxPrice:       Math.max(...sorted),
  };
}
