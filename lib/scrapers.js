/**
 * ICX Provider Scrapers
 * Each function returns: { price: number, isAvailable: boolean, rawData: object }
 * or null if the scrape fails or no data is found.
 *
 * Providers with public APIs: Lambda Labs, Azure, Vast.ai, RunPod
 * Providers without public APIs: AWS, GCP, CoreWeave, etc. → use /api/update
 */

// ─────────────────────────────────────────────
// LAMBDA LABS
// Public API: https://cloud.lambdalabs.com/api/v1/instance-types
// No auth required. Returns instance types with pricing.
// ─────────────────────────────────────────────
export async function scrapeLambdaLabs() {
  try {
    const res  = await fetch('https://cloud.lambdalabs.com/api/v1/instance-types');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Find H100 SXM5 single-GPU instance (gpu_1x_h100_sxm5 or similar)
    for (const [key, val] of Object.entries(data.data || {})) {
      if (!key.includes('h100')) continue;
      const inst    = val.instance_type;
      const numGpus = inst?.specs?.gpus ?? 1;
      const cents   = inst?.price_cents_per_hour;
      if (!cents) continue;

      const pricePerGpu = (cents / 100) / numGpus;
      return {
        price:       Math.round(pricePerGpu * 10000) / 10000,
        isAvailable: (val.regions_with_capacity_available ?? []).length > 0,
        rawData:     { key, specs: inst?.specs, regions: val.regions_with_capacity_available },
      };
    }
    return null;
  } catch (err) {
    console.error('[scraper] Lambda Labs error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// AZURE
// Public Retail Prices API – no auth required.
// NC80ads_H100_v5 = 1 x H100 80GB, on-demand, East US
// ─────────────────────────────────────────────
export async function scrapeAzure() {
  try {
    const filter = encodeURIComponent(
      "serviceName eq 'Virtual Machines'" +
      " and armRegionName eq 'eastus'" +
      " and priceType eq 'Consumption'" +
      " and contains(skuName,'NC80ads_H100')"
    );
    const url = `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=${filter}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const items = data.Items ?? [];
    // Prefer non-spot, non-low-priority on-demand price
    const item = items.find(i =>
      !i.skuName.toLowerCase().includes('spot') &&
      !i.skuName.toLowerCase().includes('low priority')
    ) ?? items[0];

    if (!item) return null;

    return {
      price:       Math.round(item.retailPrice * 10000) / 10000,
      isAvailable: true,
      rawData:     { skuName: item.skuName, retailPrice: item.retailPrice, currencyCode: item.currencyCode },
    };
  } catch (err) {
    console.error('[scraper] Azure error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// VAST.AI
// Public bundles API – no auth required.
// Returns the median ask price for available H100 SXM5 80GB single-GPU offers.
// ─────────────────────────────────────────────
export async function scrapeVastAI() {
  try {
    const query = JSON.stringify({
      gpu_name:  { eq: 'H100_SXM5' },
      num_gpus:  { eq: 1 },
      rentable:  { eq: true },
      order:     [['dph_total', 'asc']],
      limit:     20,
    });
    const url = `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const offers = data.offers ?? [];
    if (offers.length === 0) return null;

    const prices  = offers.map(o => o.dph_total).filter(p => p > 0).sort((a, b) => a - b);
    const median  = prices[Math.floor(prices.length / 2)];

    return {
      price:       Math.round(median * 10000) / 10000,
      isAvailable: true,
      rawData:     { offerCount: offers.length, samplePrices: prices.slice(0, 5) },
    };
  } catch (err) {
    console.error('[scraper] Vast.ai error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// RUNPOD
// Public GraphQL API – no auth required.
// Returns the secure (on-demand) price for H100 SXM5 80GB.
// ─────────────────────────────────────────────
export async function scrapeRunPod() {
  try {
    const query = `{
      gpuTypes {
        id displayName memoryInGb
        securePrice
        lowestPrice { minimumBidPrice uninterruptablePrice }
      }
    }`;
    const res = await fetch('https://api.runpod.io/graphql', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const gpuTypes = data.data?.gpuTypes ?? [];
    // Match H100 SXM5 80GB
    const h100 = gpuTypes.find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) &&
      g.memoryInGb === 80
    );
    if (!h100) return null;

    const price = h100.securePrice ?? h100.lowestPrice?.uninterruptablePrice;
    if (!price || price <= 0) return null;

    return {
      price:       Math.round(price * 10000) / 10000,
      isAvailable: true,
      rawData:     { id: h100.id, displayName: h100.displayName, securePrice: h100.securePrice },
    };
  } catch (err) {
    console.error('[scraper] RunPod error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// SCRAPER MAP
// Maps provider name (as stored in DB) to its scraper function.
// Providers NOT listed here must be updated manually via /api/update.
// ─────────────────────────────────────────────
export const SCRAPERS = {
  'Lambda Labs':        scrapeLambdaLabs,
  'Azure (NC H100)':    scrapeAzure,
  'Vast.ai':            scrapeVastAI,
  'RunPod (Secure)':    scrapeRunPod,
  'RunPod (Community)': scrapeRunPod,
};
