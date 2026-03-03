/**
 * ICX Provider Scrapers
 * Each function returns: { price: number, isAvailable: boolean, rawData: object }
 * or null if the scrape fails or no data is found.
 *
 * Providers with public APIs: Lambda Labs*, Azure, Vast.ai, RunPod,
 *   Vultr, Hyperstack, TensorDock, DigitalOcean, Scaleway, OVH
 *
 * * Lambda Labs requires an API key — returns null without one.
 *
 * Providers without public APIs: AWS, GCP, CoreWeave, etc. → use /api/update
 */

// ─────────────────────────────────────────────
// LAMBDA LABS
// Public API: https://cloud.lambdalabs.com/api/v1/instance-types
// NOTE: Lambda Labs requires API key auth as of 2024.
//       Without LAMBDA_API_KEY env var this will return null gracefully.
// ─────────────────────────────────────────────
export async function scrapeLambdaLabs() {
  try {
    const apiKey = process.env.LAMBDA_API_KEY;
    const headers = apiKey
      ? { Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}` }
      : {};
    const res  = await fetch('https://cloud.lambdalabs.com/api/v1/instance-types', { headers });
    if (!res.ok) {
      console.warn(`[scraper] Lambda Labs HTTP ${res.status} — API key may be required`);
      return null;
    }
    const data = await res.json();

    // Find H100 SXM5 instance (single or multi-GPU node)
    for (const [key, val] of Object.entries(data.data || {})) {
      if (!key.toLowerCase().includes('h100')) continue;
      if (!key.toLowerCase().includes('sxm5') && !key.toLowerCase().includes('sxm')) continue;
      const inst    = val.instance_type;
      const numGpus = inst?.specs?.gpus ?? 1;
      const cents   = inst?.price_cents_per_hour;
      if (!cents || numGpus <= 0) continue;

      const pricePerGpu = (cents / 100) / numGpus;
      return {
        price:       Math.round(pricePerGpu * 10000) / 10000,
        isAvailable: (val.regions_with_capacity_available ?? []).length > 0,
        rawData:     { key, numGpus, specs: inst?.specs, regions: val.regions_with_capacity_available },
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
// NC80ads H100 v5 = 1 x H100 PCIe 80GB, on-demand, East US
// ─────────────────────────────────────────────
export async function scrapeAzure() {
  try {
    // NOTE: Azure SKU names use spaces — must use 'NC80ads H100' not 'NC80ads_H100'
    const filter = encodeURIComponent(
      "serviceName eq 'Virtual Machines'" +
      " and armRegionName eq 'eastus'" +
      " and priceType eq 'Consumption'" +
      " and contains(skuName,'NC80ads H100')"
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
    // Try multiple GPU name formats Vast.ai uses
    const gpuNameVariants = ['H100_SXM5_80GB', 'H100_SXM5', 'H100 SXM5 80GB'];

    for (const gpuName of gpuNameVariants) {
      const query = JSON.stringify({
        gpu_name:  { eq: gpuName },
        num_gpus:  { eq: 1 },
        rentable:  { eq: true },
        order:     [['dph_total', 'asc']],
        limit:     20,
      });
      const url = `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) continue;
      const data = await res.json();

      const offers = data.offers ?? [];
      if (offers.length === 0) continue;

      const prices  = offers.map(o => o.dph_total).filter(p => p > 0).sort((a, b) => a - b);
      if (prices.length === 0) continue;
      const median  = prices[Math.floor(prices.length / 2)];

      return {
        price:       Math.round(median * 10000) / 10000,
        isAvailable: true,
        rawData:     { gpuName, offerCount: offers.length, samplePrices: prices.slice(0, 5) },
      };
    }
    return null;
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
// RUNPOD COMMUNITY (spot/community cloud)
// Same RunPod GraphQL API — uses lowestPrice instead of securePrice.
// ─────────────────────────────────────────────
export async function scrapeRunPodCommunity() {
  try {
    const query = `{
      gpuTypes {
        id displayName memoryInGb
        communityPrice
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
    const h100 = gpuTypes.find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) &&
      g.memoryInGb === 80
    );
    if (!h100) return null;

    // Community price = lowest bid (spot-like)
    const price = h100.communityPrice ?? h100.lowestPrice?.minimumBidPrice;
    if (!price || price <= 0) return null;

    return {
      price:       Math.round(price * 10000) / 10000,
      isAvailable: true,
      rawData:     { id: h100.id, displayName: h100.displayName, communityPrice: h100.communityPrice },
    };
  } catch (err) {
    console.error('[scraper] RunPod Community error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// VULTR CLOUD GPU
// Public plans API – no auth required.
// VCG plans include H100 PCIe 80GB (1x GPU option).
// ─────────────────────────────────────────────
export async function scrapeVultr() {
  try {
    const res = await fetch('https://api.vultr.com/v2/plans?type=vcg&per_page=100');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const plans = data.plans ?? [];
    // Find single H100 80GB PCIe plan (lowest monthly cost with H100)
    const h100Plans = plans.filter(p =>
      (p.gpu_type?.toLowerCase().includes('h100') ||
       p.gpu_vram_gb === 80) &&
      p.gpu_count === 1
    );
    if (h100Plans.length === 0) return null;

    // Sort by hourly cost ascending
    h100Plans.sort((a, b) => (a.price_per_month ?? 0) - (b.price_per_month ?? 0));
    const plan = h100Plans[0];

    // Vultr gives monthly price — convert to hourly (730 hrs/month)
    const hourly = (plan.price_per_month ?? plan.monthly_cost ?? 0) / 730;
    if (hourly <= 0) return null;

    return {
      price:       Math.round(hourly * 10000) / 10000,
      isAvailable: true,
      rawData:     { id: plan.id, gpu_type: plan.gpu_type, gpu_vram_gb: plan.gpu_vram_gb, price_per_month: plan.price_per_month },
    };
  } catch (err) {
    console.error('[scraper] Vultr error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// HYPERSTACK (Nexgen Cloud)
// Public GPU availability API – no auth required.
// Returns H100 SXM5 on-demand pricing.
// ─────────────────────────────────────────────
export async function scrapeHyperstack() {
  try {
    const res = await fetch('https://infrahub-api.nexgencloud.com/v1/core/gpu-availabilities', {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const gpus = data.data ?? data.gpu_availabilities ?? data ?? [];
    const entries = Array.isArray(gpus) ? gpus : Object.values(gpus);

    // Find H100 SXM5 single-GPU flavour
    const h100 = entries.find(g => {
      const name = (g.gpu_name ?? g.name ?? g.gpu_model ?? '').toLowerCase();
      return name.includes('h100') && (name.includes('sxm') || !name.includes('pcie'));
    });
    if (!h100) return null;

    const price = h100.price_per_hour ?? h100.hourly_price ?? h100.on_demand_price;
    if (!price || price <= 0) return null;

    return {
      price:       Math.round(price * 10000) / 10000,
      isAvailable: (h100.available_quantity ?? h100.available ?? 1) > 0,
      rawData:     h100,
    };
  } catch (err) {
    console.error('[scraper] Hyperstack error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// TENSORDOCK
// Public marketplace API – no auth required.
// Returns median H100 SXM5 price from available host nodes.
// ─────────────────────────────────────────────
export async function scrapeTensorDock() {
  try {
    const res = await fetch('https://marketplace.tensordock.com/api/v0/client/deploy/hostnodes', {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const nodes = data.hostnodes ?? data.nodes ?? data ?? {};
    const nodeList = Array.isArray(nodes) ? nodes : Object.values(nodes);

    // Collect all H100 SXM5 single-GPU prices
    const prices = [];
    for (const node of nodeList) {
      const gpus = node.specs?.gpu ?? node.gpus ?? {};
      for (const [gpuModel, gpuInfo] of Object.entries(gpus)) {
        const lower = gpuModel.toLowerCase();
        if (!lower.includes('h100')) continue;
        if (lower.includes('pcie')) continue;
        const pricePerGpu = gpuInfo.price ?? gpuInfo.price_per_gpu ?? gpuInfo.hourly_price;
        if (pricePerGpu && pricePerGpu > 0) prices.push(pricePerGpu);
      }
    }
    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];

    return {
      price:       Math.round(median * 10000) / 10000,
      isAvailable: true,
      rawData:     { offerCount: prices.length, samplePrices: prices.slice(0, 5) },
    };
  } catch (err) {
    console.error('[scraper] TensorDock error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// SCALEWAY
// Public pricing API – no auth required.
// GPU H100 instances (H100-1-80G = 1x H100 PCIe 80GB).
// ─────────────────────────────────────────────
export async function scrapeScaleway() {
  try {
    const res = await fetch(
      'https://www.scaleway.com/en/pricing/gpu-instances/?currency=USD',
      { headers: { 'Accept': 'text/html,application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Scaleway embeds pricing JSON in a __NEXT_DATA__ script tag
    const html = await res.text();
    const match = html.match(/"H100[^"]*"[^}]{0,400}"price_per_hour":\s*([\d.]+)/);
    if (match) {
      const price = parseFloat(match[1]);
      if (price > 0) {
        return { price: Math.round(price * 10000) / 10000, isAvailable: true, rawData: { source: 'html-parse' } };
      }
    }
    return null;
  } catch (err) {
    console.error('[scraper] Scaleway error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// OVH CLOUD (US)
// Public pricing catalog – no auth required.
// H100 GPU instances via OVH's catalog API.
// ─────────────────────────────────────────────
export async function scrapeOVH() {
  try {
    const res = await fetch(
      'https://www.ovhcloud.com/en/public-cloud/prices/',
      { headers: { 'Accept': 'text/html' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Match H100 hourly price embedded in page data
    const match = html.match(/H100[^<]{0,200}?\$\s*([\d.]+)\s*\/\s*hour/i) ??
                  html.match(/H100[^<]{0,200}?([\d.]+)\s*\/hr/i);
    if (match) {
      const price = parseFloat(match[1]);
      if (price > 0) return { price: Math.round(price * 10000) / 10000, isAvailable: true, rawData: { source: 'html-parse' } };
    }
    return null;
  } catch (err) {
    console.error('[scraper] OVH error:', err.message);
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
  'RunPod (Community)': scrapeRunPodCommunity,
  'Vultr':              scrapeVultr,
  'Hyperstack':         scrapeHyperstack,
  'TensorDock':         scrapeTensorDock,
  'Scaleway':           scrapeScaleway,
  'OVH':                scrapeOVH,
};
