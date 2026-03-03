/**
 * ICX Provider Scrapers
 * Each function returns: { price: number, isAvailable: boolean, rawData: object }
 * or null if the scrape fails or no data is found.
 *
 * All scrapers use a 10 s AbortController timeout so one slow provider
 * cannot block the parallel scrape loop in /api/scrape.
 */

// ── Shared utilities ──────────────────────────────────────────────

/** Fetch with an AbortController timeout (default 10 s). */
async function fetchT(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ICXBot/1.0)',
        'Accept': 'text/html,application/json,*/*',
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan HTML around each occurrence of "H100" and return the lowest
 * dollar price found within 400 chars of that keyword.
 * Sanity range: $0.50 – $25 / GPU / hr.
 */
function h100Price(html, min = 0.5, max = 25) {
  const chunks = html.split(/H100/gi);
  const found  = [];
  for (const chunk of chunks.slice(1)) {
    const text = chunk.slice(0, 400);
    // "$2.49" or "2.49/hr" or "2.49 / hour" patterns
    const m = text.match(/\$\s*([\d]+\.[\d]{1,2})/);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= min && v <= max) found.push(v);
    }
  }
  return found.length ? Math.min(...found) : null;
}

/** Shared result builder. */
function ok(price, rawData = {}) {
  return { price: Math.round(price * 10000) / 10000, isAvailable: true, rawData };
}

// ─────────────────────────────────────────────
// AWS (p5)
// ec2.shop (Vantage) compact pricing endpoint – public, no auth.
// p5.48xlarge = 8 × H100 SXM5 80 GB → divide by 8 for per-GPU price.
// ─────────────────────────────────────────────
export async function scrapeAWS() {
  try {
    const res  = await fetchT(
      'https://ec2.shop?instance=p5.48xlarge&os=linux&region=us-east-1',
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cost = data.Instances?.[0]?.cost;
    if (!cost) return null;
    return ok(cost / 8, data.Instances[0]);
  } catch (e) { console.error('[scraper] AWS:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Google Cloud (a3)
// Parses the public GCP GPU pricing page.
// a3-highgpu-1g = 1 × H100 SXM5 80 GB, ~$14/hr on-demand.
// ─────────────────────────────────────────────
export async function scrapeGCP() {
  try {
    const res  = await fetchT('https://cloud.google.com/compute/gpus-pricing');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Look for A3 or H100 pricing table entries
    const a3Match = html.match(/a3-highgpu[^<]{0,200}\$\s*([\d]+\.[\d]{2})/i)
                 ?? html.match(/H100[^<]{0,300}us-central[^<]{0,300}\$\s*([\d]+\.[\d]{2})/i);
    if (a3Match) {
      const price = parseFloat(a3Match[1]);
      if (price >= 5 && price <= 25) return ok(price, { source: 'gcp-pricing-page' });
    }
    // Fallback: generic H100 price scan
    const price = h100Price(html, 5, 25);
    if (price) return ok(price, { source: 'gcp-pricing-page-generic' });
    return null;
  } catch (e) { console.error('[scraper] GCP:', e.message); return null; }
}

// ─────────────────────────────────────────────
// CoreWeave
// Pricing page: https://www.coreweave.com/gpu-cloud-compute-pricing
// H100 SXM5 (NVLink) listed on the page.
// ─────────────────────────────────────────────
export async function scrapeCoreweve() {
  try {
    const res  = await fetchT('https://www.coreweave.com/gpu-cloud-compute-pricing');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Look for NVLink / SXM5 H100 price specifically
    const nvMatch = html.match(/(?:SXM5|NVLink)[^<]{0,300}\$\s*([\d]+\.[\d]{2})/i)
                 ?? html.match(/\$\s*([\d]+\.[\d]{2})[^<]{0,100}(?:SXM5|NVLink)/i);
    if (nvMatch) {
      const price = parseFloat(nvMatch[1]);
      if (price >= 0.5 && price <= 20) return ok(price, { source: 'coreweave-pricing-page' });
    }
    const price = h100Price(html);
    if (price) return ok(price, { source: 'coreweave-pricing-page-generic' });
    return null;
  } catch (e) { console.error('[scraper] CoreWeave:', e.message); return null; }
}

// ─────────────────────────────────────────────
// GMI Cloud
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeGMICloud() {
  try {
    const res  = await fetchT('https://www.gmi.cloud/pricing');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = h100Price(html);
    if (price) return ok(price, { source: 'gmi-pricing-page' });
    return null;
  } catch (e) { console.error('[scraper] GMI Cloud:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Nebius
// Public pricing page at nebius.com.
// ─────────────────────────────────────────────
export async function scrapeNebius() {
  try {
    const res  = await fetchT('https://nebius.com/prices/compute');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = h100Price(html);
    if (price) return ok(price, { source: 'nebius-pricing-page' });
    return null;
  } catch (e) { console.error('[scraper] Nebius:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Thunder Compute
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeThunderCompute() {
  try {
    // Try dedicated pricing page first, then homepage
    for (const url of ['https://thundercompute.com/pricing', 'https://thundercompute.com']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Thunder Compute:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Jarvislabs
// Public pricing page at jarvislabs.ai.
// ─────────────────────────────────────────────
export async function scrapeJarvislabs() {
  try {
    for (const url of ['https://jarvislabs.ai/pricing', 'https://jarvislabs.ai']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Jarvislabs:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Novita AI
// Public GPU instance API or pricing page.
// ─────────────────────────────────────────────
export async function scrapeNovitaAI() {
  try {
    // Try public API first
    const apiRes = await fetchT(
      'https://api.novita.ai/v3/gpu-instance/list_available_resources',
      { headers: { Accept: 'application/json' } }
    );
    if (apiRes.ok) {
      const data = await apiRes.json();
      const gpus  = data.gpus ?? data.resources ?? [];
      const h100  = gpus.find(g => g.gpu_name?.includes('H100') || g.name?.includes('H100'));
      const price = h100?.price_per_hour ?? h100?.hourly_price;
      if (price && price > 0) return ok(price, h100);
    }
    // Fallback: pricing page
    const pageRes = await fetchT('https://novita.ai/gpu-instance');
    if (pageRes.ok) {
      const html = await pageRes.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: 'novita-pricing-page' });
    }
    return null;
  } catch (e) { console.error('[scraper] Novita AI:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Oblivus  (PCIe H100)
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeOblivus() {
  try {
    for (const url of ['https://oblivus.com/gpu-pricing', 'https://oblivus.com/pricing', 'https://oblivus.com']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Oblivus:', e.message); return null; }
}

// ─────────────────────────────────────────────
// FluidStack
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeFluidStack() {
  try {
    for (const url of ['https://fluidstack.io/pricing', 'https://fluidstack.io']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] FluidStack:', e.message); return null; }
}

// ─────────────────────────────────────────────
// CUDO Compute
// Public REST API: https://rest.compute.cudo.org/v1/instance-types
// No auth required for listing instance types and pricing.
// ─────────────────────────────────────────────
export async function scrapeCUDO() {
  try {
    const res  = await fetchT('https://rest.compute.cudo.org/v1/instance-types', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const types = data.instanceTypes ?? data.instance_types ?? data ?? [];
    const list  = Array.isArray(types) ? types : Object.values(types);
    const h100  = list.find(t => {
      const n = (t.gpu ?? t.gpu_model ?? t.name ?? '').toLowerCase();
      return n.includes('h100') && !n.includes('pcie');
    });
    const price = h100?.price_per_gpu_hr ?? h100?.gpu_price ?? h100?.price_hr;
    if (price && price > 0) return ok(price, h100);
    // Fallback: pricing page
    const pageRes = await fetchT('https://compute.cudo.org/pricing');
    if (pageRes.ok) {
      const html = await pageRes.text();
      const p = h100Price(html);
      if (p) return ok(p, { source: 'cudo-pricing-page' });
    }
    return null;
  } catch (e) { console.error('[scraper] CUDO Compute:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Verda
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeVerda() {
  try {
    for (const url of ['https://verda.cloud/pricing', 'https://verda.cloud']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Verda:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Civo  (PCIe H100)
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeCivo() {
  try {
    for (const url of ['https://www.civo.com/gpu', 'https://www.civo.com/pricing']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Civo:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Sesterce
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeSesterce() {
  try {
    for (const url of ['https://sesterce.com/pricing', 'https://sesterce.com']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Sesterce:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Koyeb
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeKoyeb() {
  try {
    const res  = await fetchT('https://www.koyeb.com/pricing');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html  = await res.text();
    const price = h100Price(html);
    if (price) return ok(price, { source: 'koyeb-pricing' });
    return null;
  } catch (e) { console.error('[scraper] Koyeb:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Together AI
// GPU cloud pricing page (not inference — looking for bare-metal H100 rental).
// ─────────────────────────────────────────────
export async function scrapeTogetherAI() {
  try {
    for (const url of ['https://www.together.ai/pricing', 'https://api.together.ai/pricing']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Together AI:', e.message); return null; }
}

// ─────────────────────────────────────────────
// DigitalOcean
// GPU Droplets pricing page (H100 PCIe 80GB).
// ─────────────────────────────────────────────
export async function scrapeDigitalOcean() {
  try {
    const res  = await fetchT('https://www.digitalocean.com/pricing/gpu-droplets');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html  = await res.text();
    const price = h100Price(html);
    if (price) return ok(price, { source: 'do-gpu-droplets-page' });
    return null;
  } catch (e) { console.error('[scraper] DigitalOcean:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Paperspace (PCIe H100)
// Now part of DigitalOcean. Pricing page.
// ─────────────────────────────────────────────
export async function scrapePaperspace() {
  try {
    for (const url of [
      'https://www.paperspace.com/pricing',
      'https://www.paperspace.com/gpu-cloud',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Paperspace:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Gcore
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeGcore() {
  try {
    for (const url of ['https://gcore.com/cloud/gpu', 'https://gcore.com/pricing/cloud']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Gcore:', e.message); return null; }
}

// ─────────────────────────────────────────────
// LAMBDA LABS
// NOTE: Requires LAMBDA_API_KEY env var — returns null without it.
// ─────────────────────────────────────────────
export async function scrapeLambdaLabs() {
  try {
    const apiKey = process.env.LAMBDA_API_KEY;
    const headers = apiKey
      ? { Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}` }
      : {};
    const res  = await fetchT('https://cloud.lambdalabs.com/api/v1/instance-types', { headers });
    if (!res.ok) { console.warn(`[scraper] Lambda Labs HTTP ${res.status}`); return null; }
    const data = await res.json();
    for (const [key, val] of Object.entries(data.data || {})) {
      if (!key.toLowerCase().includes('h100')) continue;
      if (!key.toLowerCase().includes('sxm')) continue;
      const inst    = val.instance_type;
      const numGpus = inst?.specs?.gpus ?? 1;
      const cents   = inst?.price_cents_per_hour;
      if (!cents || numGpus <= 0) continue;
      return ok((cents / 100) / numGpus, { key, numGpus, specs: inst?.specs });
    }
    return null;
  } catch (e) { console.error('[scraper] Lambda Labs:', e.message); return null; }
}

// ─────────────────────────────────────────────
// AZURE  (NC H100 = PCIe)
// Public Retail Prices API – no auth required.
// IMPORTANT: Azure SKU names use spaces, not underscores.
// ─────────────────────────────────────────────
export async function scrapeAzure() {
  try {
    const filter = encodeURIComponent(
      "serviceName eq 'Virtual Machines'" +
      " and armRegionName eq 'eastus'" +
      " and priceType eq 'Consumption'" +
      " and contains(skuName,'NC80ads H100')"
    );
    const url = `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=${filter}`;
    const res  = await fetchT(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const items = data.Items ?? [];
    const item  = items.find(i =>
      !i.skuName.toLowerCase().includes('spot') &&
      !i.skuName.toLowerCase().includes('low priority')
    ) ?? items[0];
    if (!item) return null;
    return ok(item.retailPrice, { skuName: item.skuName, retailPrice: item.retailPrice });
  } catch (e) { console.error('[scraper] Azure:', e.message); return null; }
}

// ─────────────────────────────────────────────
// VAST.AI
// Public bundles API – no auth required. Tries multiple GPU name formats.
// ─────────────────────────────────────────────
export async function scrapeVastAI() {
  try {
    for (const gpuName of ['H100_SXM5_80GB', 'H100_SXM5', 'H100 SXM5 80GB']) {
      const query = JSON.stringify({
        gpu_name: { eq: gpuName }, num_gpus: { eq: 1 },
        rentable: { eq: true }, order: [['dph_total', 'asc']], limit: 20,
      });
      const res = await fetchT(
        `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(query)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) continue;
      const data   = await res.json();
      const offers = data.offers ?? [];
      if (!offers.length) continue;
      const prices = offers.map(o => o.dph_total).filter(p => p > 0).sort((a, b) => a - b);
      if (!prices.length) continue;
      return ok(prices[Math.floor(prices.length / 2)], { gpuName, offerCount: offers.length });
    }
    return null;
  } catch (e) { console.error('[scraper] Vast.ai:', e.message); return null; }
}

// ─────────────────────────────────────────────
// RUNPOD (Secure)
// Public GraphQL API – no auth.
// ─────────────────────────────────────────────
export async function scrapeRunPod() {
  try {
    const query = `{ gpuTypes { id displayName memoryInGb securePrice lowestPrice { minimumBidPrice uninterruptablePrice } } }`;
    const res = await fetchT('https://api.runpod.io/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const h100 = (data.data?.gpuTypes ?? []).find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) &&
      g.memoryInGb === 80
    );
    if (!h100) return null;
    const price = h100.securePrice ?? h100.lowestPrice?.uninterruptablePrice;
    if (!price || price <= 0) return null;
    return ok(price, { id: h100.id, displayName: h100.displayName });
  } catch (e) { console.error('[scraper] RunPod:', e.message); return null; }
}

// ─────────────────────────────────────────────
// RUNPOD COMMUNITY (spot / community cloud)
// Same GraphQL API — uses communityPrice / minimumBidPrice.
// ─────────────────────────────────────────────
export async function scrapeRunPodCommunity() {
  try {
    const query = `{ gpuTypes { id displayName memoryInGb communityPrice lowestPrice { minimumBidPrice } } }`;
    const res = await fetchT('https://api.runpod.io/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const h100 = (data.data?.gpuTypes ?? []).find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) &&
      g.memoryInGb === 80
    );
    if (!h100) return null;
    const price = h100.communityPrice ?? h100.lowestPrice?.minimumBidPrice;
    if (!price || price <= 0) return null;
    return ok(price, { id: h100.id, communityPrice: h100.communityPrice });
  } catch (e) { console.error('[scraper] RunPod Community:', e.message); return null; }
}

// ─────────────────────────────────────────────
// VULTR Cloud GPU
// Public plans API – no auth required.
// ─────────────────────────────────────────────
export async function scrapeVultr() {
  try {
    const res  = await fetchT('https://api.vultr.com/v2/plans?type=vcg&per_page=100');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const plans = (data.plans ?? []).filter(p =>
      (p.gpu_type?.toLowerCase().includes('h100') || p.gpu_vram_gb === 80) && p.gpu_count === 1
    );
    if (!plans.length) return null;
    plans.sort((a, b) => (a.price_per_month ?? 0) - (b.price_per_month ?? 0));
    const plan   = plans[0];
    const hourly = (plan.price_per_month ?? plan.monthly_cost ?? 0) / 730;
    if (hourly <= 0) return null;
    return ok(hourly, { id: plan.id, gpu_type: plan.gpu_type });
  } catch (e) { console.error('[scraper] Vultr:', e.message); return null; }
}

// ─────────────────────────────────────────────
// HYPERSTACK (Nexgen Cloud)
// Public GPU availability API – no auth required.
// ─────────────────────────────────────────────
export async function scrapeHyperstack() {
  try {
    const res  = await fetchT('https://infrahub-api.nexgencloud.com/v1/core/gpu-availabilities', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data    = await res.json();
    const entries = Array.isArray(data?.data) ? data.data : Object.values(data?.data ?? data ?? {});
    const h100    = entries.find(g => {
      const name = (g.gpu_name ?? g.name ?? g.gpu_model ?? '').toLowerCase();
      return name.includes('h100') && !name.includes('pcie');
    });
    if (!h100) return null;
    const price = h100.price_per_hour ?? h100.hourly_price ?? h100.on_demand_price;
    if (!price || price <= 0) return null;
    return ok(price, h100);
  } catch (e) { console.error('[scraper] Hyperstack:', e.message); return null; }
}

// ─────────────────────────────────────────────
// TENSORDOCK
// Public marketplace API – no auth required.
// ─────────────────────────────────────────────
export async function scrapeTensorDock() {
  try {
    const res  = await fetchT(
      'https://marketplace.tensordock.com/api/v0/client/deploy/hostnodes',
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data     = await res.json();
    const nodeList = Array.isArray(data?.hostnodes) ? data.hostnodes : Object.values(data?.hostnodes ?? {});
    const prices   = [];
    for (const node of nodeList) {
      const gpus = node.specs?.gpu ?? node.gpus ?? {};
      for (const [model, info] of Object.entries(gpus)) {
        if (!model.toLowerCase().includes('h100')) continue;
        if (model.toLowerCase().includes('pcie')) continue;
        const p = info.price ?? info.price_per_gpu ?? info.hourly_price;
        if (p && p > 0) prices.push(p);
      }
    }
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    return ok(prices[Math.floor(prices.length / 2)], { offerCount: prices.length });
  } catch (e) { console.error('[scraper] TensorDock:', e.message); return null; }
}

// ─────────────────────────────────────────────
// SCALEWAY
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeScaleway() {
  try {
    const res  = await fetchT('https://www.scaleway.com/en/pricing/gpu-instances/');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html  = await res.text();
    const price = h100Price(html);
    if (price) return ok(price, { source: 'scaleway-pricing-page' });
    return null;
  } catch (e) { console.error('[scraper] Scaleway:', e.message); return null; }
}

// ─────────────────────────────────────────────
// OVH
// Public pricing page.
// ─────────────────────────────────────────────
export async function scrapeOVH() {
  try {
    for (const url of [
      'https://www.ovhcloud.com/en/public-cloud/gpu/',
      'https://www.ovhcloud.com/en/public-cloud/prices/',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] OVH:', e.message); return null; }
}

// ─────────────────────────────────────────────
// SCRAPER MAP
// Maps provider name (as stored in DB) to its scraper function.
// All providers are represented here — no manual fallback needed.
// ─────────────────────────────────────────────
export const SCRAPERS = {
  // Hyperscalers
  'AWS (p5)':           scrapeAWS,
  'Google Cloud (a3)':  scrapeGCP,
  'Azure (NC H100)':    scrapeAzure,

  // Tier-1 specialists
  'Lambda Labs':        scrapeLambdaLabs,
  'RunPod (Secure)':    scrapeRunPod,
  'RunPod (Community)': scrapeRunPodCommunity,
  'CoreWeave':          scrapeCoreweve,
  'Vast.ai':            scrapeVastAI,

  // Mid-tier
  'Hyperstack':         scrapeHyperstack,
  'GMI Cloud':          scrapeGMICloud,
  'TensorDock':         scrapeTensorDock,
  'Nebius':             scrapeNebius,
  'Thunder Compute':    scrapeThunderCompute,
  'Jarvislabs':         scrapeJarvislabs,
  'Novita AI':          scrapeNovitaAI,
  'Oblivus':            scrapeOblivus,
  'FluidStack':         scrapeFluidStack,
  'CUDO Compute':       scrapeCUDO,
  'Verda':              scrapeVerda,
  'Civo':               scrapeCivo,
  'OVH':                scrapeOVH,
  'Scaleway':           scrapeScaleway,
  'Sesterce':           scrapeSesterce,
  'Koyeb':              scrapeKoyeb,
  'Together AI':        scrapeTogetherAI,
  'DigitalOcean':       scrapeDigitalOcean,
  'Paperspace':         scrapePaperspace,
  'Gcore':              scrapeGcore,
  'Vultr':              scrapeVultr,
};
