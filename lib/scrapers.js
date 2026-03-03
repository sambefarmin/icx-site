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
async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan HTML around every occurrence of "H100" and return the lowest
 * dollar (or EUR/GBP) price found within 600 chars of that keyword.
 * Also scans BEFORE the H100 keyword (some pages put price first).
 * Sanity range: $0.50 – $25 / GPU / hr.
 */
function h100Price(html, min = 0.5, max = 25) {
  const found = [];

  // 1. Window around each H100 mention (±600 chars)
  for (let i = 0; i < html.length; i++) {
    if (html.slice(i, i + 4).toLowerCase() !== 'h100') continue;
    const window = html.slice(Math.max(0, i - 200), i + 600);
    const prices = extractPrices(window, min, max);
    found.push(...prices);
  }

  // 2. Generic page scan for any $/€/£ price in a reasonable range
  //    (only used if no H100-specific hit found)
  if (found.length === 0) {
    const prices = extractPrices(html, min, max);
    found.push(...prices);
  }

  return found.length ? Math.min(...found) : null;
}

/** Extract all price values from a text snippet. */
function extractPrices(text, min, max) {
  const found = [];
  // Patterns: $2.49, €2.49, £2.49, USD 2.49, 2.49 USD, 2.49/hr, 2.49 per hour
  const patterns = [
    /[$€£]\s*([\d]+\.[\d]{1,2})/g,
    /([\d]+\.[\d]{1,2})\s*(?:USD|EUR|GBP)/gi,
    /([\d]+\.[\d]{1,2})\s*\/\s*(?:hr|hour|GPU-hr)/gi,
    /([\d]+\.[\d]{1,2})\s*per\s+hour/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v >= min && v <= max) found.push(v);
    }
  }
  return found;
}

/**
 * Many modern sites (Next.js, Nuxt) embed their full data as JSON in the HTML.
 * Try to extract it and return a flat string representation for further parsing.
 */
function embeddedJsonText(html) {
  // Next.js
  const next = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (next) return next[1];
  // Nuxt
  const nuxt = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?);\s*<\/script>/i);
  if (nuxt) return nuxt[1];
  // Any application/json script block
  const jsonScript = html.match(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonScript) return jsonScript[1];
  return null;
}

/** Shared result builder. */
function ok(price, rawData = {}) {
  return { price: Math.round(price * 10000) / 10000, isAvailable: true, rawData };
}

// ─────────────────────────────────────────────
// AWS (p5)
// instances.vantage.sh is Vantage's maintained public EC2 pricing dataset.
// p5.48xlarge = 8 × H100 SXM5 80 GB → divide by 8 for per-GPU price.
// ─────────────────────────────────────────────
export async function scrapeAWS() {
  try {
    // instances.vantage.sh/instances.json is a ~4 MB JSON array with all EC2
    // on-demand pricing. We filter client-side for p5.48xlarge.
    const res  = await fetchT('https://instances.vantage.sh/instances.json', {
      headers: { Accept: 'application/json' },
    }, 20000); // larger timeout for bigger file
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const p5   = data.find(i => i.instance_type === 'p5.48xlarge');
    const raw  = p5?.pricing?.['us-east-1']?.linux?.ondemand;
    const cost = raw ? parseFloat(raw) : 0;
    if (!cost) return null;
    return ok(cost / 8, { instance_type: 'p5.48xlarge', ondemand_per_node: cost });
  } catch (e) { console.error('[scraper] AWS:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Google Cloud (a3)
// Uses GCP's public cloudpricingcalculator JSON which includes GPU VM pricing.
// a3-highgpu-8g (or 1g) = H100 SXM5 80GB.
// Falls back to pricing page HTML parse.
// ─────────────────────────────────────────────
export async function scrapeGCP() {
  try {
    // 1. GCP Cloud Pricing Calculator JSON — a3-highgpu-8g = 8× H100 SXM5
    //    Key format: CP-COMPUTEENGINE-VMIMAGE-A3-HIGHGPU-8G (no 'H100' in key name)
    const res = await fetchT(
      'https://cloudpricingcalculator.appspot.com/static/data/pricelist.json',
      { headers: { Accept: 'application/json' } }, 20000
    );
    if (res.ok) {
      const data = await res.json();
      for (const [key, val] of Object.entries(data)) {
        const k = key.toUpperCase();
        // Match A3 high-GPU 8G node (8× H100 SXM5)
        if (!k.includes('A3')) continue;
        if (!k.includes('HIGHGPU') && !k.includes('HIGH-GPU') && !k.includes('H100')) continue;
        // Price is per-node; us-central1 or 'us' key
        const nodePrice = val?.['us-central1'] ?? val?.us ?? val?.['us-east1'];
        if (!nodePrice || nodePrice <= 0) continue;
        const numGpus = k.includes('8G') || k.includes('8-GPU') ? 8 : 1;
        const perGpu  = nodePrice / numGpus;
        if (perGpu >= 1 && perGpu <= 30) return ok(perGpu, { key, nodePrice, numGpus });
      }
    }

    // 2. GCP static pricing JSON (gstatic)
    const gsRes = await fetchT(
      'https://www.gstatic.com/cloud-site-ux/pricing/data/gcp-price-list.json',
      { headers: { Accept: 'application/json' } }, 20000
    );
    if (gsRes.ok) {
      const data = await gsRes.json();
      for (const [key, val] of Object.entries(data?.gcp_price_list ?? data ?? {})) {
        const k = key.toUpperCase();
        if (!k.includes('A3') || (!k.includes('HIGHGPU') && !k.includes('H100'))) continue;
        const nodePrice = val?.us ?? val?.['us-central1'];
        if (!nodePrice || nodePrice <= 0) continue;
        const numGpus = k.includes('8G') ? 8 : 1;
        const perGpu  = nodePrice / numGpus;
        if (perGpu >= 1 && perGpu <= 30) return ok(perGpu, { key, nodePrice, numGpus });
      }
    }

    // 3. GCP VM pricing page (SSR — may have embedded JSON)
    for (const url of [
      'https://cloud.google.com/compute/vm-instance-pricing',
      'https://cloud.google.com/compute/gpus-pricing',
    ]) {
      const pageRes = await fetchT(url, {}, 15000);
      if (!pageRes.ok) continue;
      const html   = await pageRes.text();
      const embeds = embeddedJsonText(html);
      if (embeds) {
        const price = h100Price(embeds, 1.5, 30);
        if (price) return ok(price, { source: url + '+json' });
      }
      const price = h100Price(html, 1.5, 30);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] GCP:', e.message); return null; }
}

// ─────────────────────────────────────────────
// Azure  H100
// ND H100 v5 = SXM5 NVLink (8-GPU node — divide by 8)
// NC H100 v5 = PCIe (1 GPU per VM — no division)
// Azure Retail Prices API — public, no auth.
// ─────────────────────────────────────────────
export async function scrapeAzure() {
  try {
    const base = 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview';

    // 1. ND H100 v5 — SXM5 NVLink, 8-GPU node
    const ndFilters = [
      "armSkuName eq 'Standard_ND96isr_H100_v5' and priceType eq 'Consumption' and armRegionName eq 'eastus'",
      "serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and priceType eq 'Consumption' and contains(armSkuName,'ND96isr_H100')",
      "serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and priceType eq 'Consumption' and contains(skuName,'ND H100 v5')",
    ];
    for (const filter of ndFilters) {
      const res  = await fetchT(`${base}&$filter=${encodeURIComponent(filter)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data  = await res.json();
      const items = (data.Items ?? []).filter(i =>
        !i.skuName?.toLowerCase().includes('spot') &&
        !i.skuName?.toLowerCase().includes('low priority')
      );
      const item = items[0];
      if (item?.retailPrice > 0) {
        // ND96isr H100 v5 is an 8-GPU node; price is per node-hour
        const perGpu = item.retailPrice / 8;
        return ok(perGpu, { skuName: item.skuName, armSkuName: item.armSkuName, nodePrice: item.retailPrice, gpus: 8 });
      }
    }

    // 2. NC H100 v5 — PCIe, 1 GPU per VM (fallback)
    const ncFilters = [
      "armSkuName eq 'Standard_NC80ads_H100_v5' and priceType eq 'Consumption' and armRegionName eq 'eastus'",
      "serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and priceType eq 'Consumption' and contains(skuName,'NC80ads H100')",
    ];
    for (const filter of ncFilters) {
      const res  = await fetchT(`${base}&$filter=${encodeURIComponent(filter)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data  = await res.json();
      const items = (data.Items ?? []).filter(i =>
        !i.skuName?.toLowerCase().includes('spot') &&
        !i.skuName?.toLowerCase().includes('low priority')
      );
      const item = items[0];
      if (item?.retailPrice > 0) {
        return ok(item.retailPrice, { skuName: item.skuName, armSkuName: item.armSkuName });
      }
    }
    return null;
  } catch (e) { console.error('[scraper] Azure:', e.message); return null; }
}

// ─────────────────────────────────────────────
// LAMBDA LABS
// Requires LAMBDA_API_KEY env var — returns null without it.
// ─────────────────────────────────────────────
export async function scrapeLambdaLabs() {
  try {
    // 1. Authenticated API (requires LAMBDA_API_KEY env var)
    const apiKey = process.env.LAMBDA_API_KEY;
    if (apiKey) {
      const res = await fetchT('https://cloud.lambdalabs.com/api/v1/instance-types', {
        headers: { Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}` },
      });
      if (res.ok) {
        const data = await res.json();
        // Lambda marks H100 PCIe instances — look for H100 without SXM
        for (const [key, val] of Object.entries(data.data || {})) {
          const k = key.toLowerCase();
          if (!k.includes('h100')) continue;
          const inst    = val.instance_type;
          const numGpus = inst?.specs?.gpus ?? 1;
          const cents   = inst?.price_cents_per_hour;
          if (!cents || numGpus <= 0) continue;
          return ok((cents / 100) / numGpus, { key, numGpus });
        }
      }
    }

    // 2. Public pricing page — Lambda Labs uses Next.js (SSR with __NEXT_DATA__)
    for (const url of [
      'https://lambdalabs.com/service/gpu-cloud',
      'https://lambdalabs.com/pricing',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed, 0.8, 20);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html, 0.8, 20);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Lambda Labs:', e.message); return null; }
}

// ─────────────────────────────────────────────
// VAST.AI  — public bundles API.
// Tries multiple GPU name formats; returns median ask price.
// ─────────────────────────────────────────────
export async function scrapeVastAI() {
  try {
    const gpuNames = ['H100_SXM5_80GB', 'H100_SXM5', 'H100 SXM5 80GB', 'H100 SXM5', 'H100'];
    // Try both API domains — Vast.ai migrated from console. to cloud.
    const domains = ['https://cloud.vast.ai', 'https://console.vast.ai'];
    for (const domain of domains) {
      for (const gpuName of gpuNames) {
        const q = JSON.stringify({
          gpu_name: { eq: gpuName }, num_gpus: { eq: 1 },
          rentable: { eq: true }, order: [['dph_total', 'asc']], limit: 30,
        });
        const res = await fetchT(
          `${domain}/api/v0/bundles/?q=${encodeURIComponent(q)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!res.ok) continue;
        const data   = await res.json();
        const offers = data.offers ?? data.bundles ?? [];
        if (!offers.length) continue;
        const prices = offers
          .map(o => o.dph_total ?? o.dph_base ?? o.min_bid)
          .filter(p => typeof p === 'number' && p > 0.5 && p < 20)
          .sort((a, b) => a - b);
        if (!prices.length) continue;
        return ok(prices[Math.floor(prices.length / 2)], { gpuName, domain, offerCount: offers.length });
      }
    }
    return null;
  } catch (e) { console.error('[scraper] Vast.ai:', e.message); return null; }
}

// ─────────────────────────────────────────────
// RUNPOD (Secure)  — public GraphQL API.
// ─────────────────────────────────────────────
export async function scrapeRunPod() {
  try {
    const query = `{ gpuTypes { id displayName memoryInGb securePrice lowestPrice { minimumBidPrice uninterruptablePrice } } }`;
    const res   = await fetchT('https://api.runpod.io/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const h100 = (data.data?.gpuTypes ?? []).find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) && g.memoryInGb === 80
    );
    if (!h100) return null;
    const price = h100.securePrice ?? h100.lowestPrice?.uninterruptablePrice;
    if (!price || price <= 0) return null;
    return ok(price, { id: h100.id, displayName: h100.displayName });
  } catch (e) { console.error('[scraper] RunPod:', e.message); return null; }
}

// ─────────────────────────────────────────────
// RUNPOD COMMUNITY  — same GraphQL, uses communityPrice.
// ─────────────────────────────────────────────
export async function scrapeRunPodCommunity() {
  try {
    const query = `{ gpuTypes { id displayName memoryInGb communityPrice lowestPrice { minimumBidPrice } } }`;
    const res   = await fetchT('https://api.runpod.io/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const h100 = (data.data?.gpuTypes ?? []).find(g =>
      g.displayName?.includes('H100') &&
      (g.displayName?.includes('SXM') || g.id?.includes('SXM')) && g.memoryInGb === 80
    );
    if (!h100) return null;
    const price = h100.communityPrice ?? h100.lowestPrice?.minimumBidPrice;
    if (!price || price <= 0) return null;
    return ok(price, { id: h100.id, communityPrice: h100.communityPrice });
  } catch (e) { console.error('[scraper] RunPod Community:', e.message); return null; }
}

// ─────────────────────────────────────────────
// VULTR Cloud GPU (VCG)
// Public plans API — no auth required.
// H100 plans may be multi-GPU nodes; divide by gpu_count for per-GPU price.
// ─────────────────────────────────────────────
export async function scrapeVultr() {
  try {
    // Try VCG plan type (Vultr Cloud GPU)
    for (const planType of ['vcg', 'vhg', 'gpu']) {
      const res = await fetchT(`https://api.vultr.com/v2/plans?type=${planType}&per_page=100`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data  = await res.json();
      const plans = (data.plans ?? []).filter(p => {
        const gpuType = (p.gpu_type ?? '').toLowerCase();
        return gpuType.includes('h100') || p.gpu_vram_gb >= 80;
      });
      if (!plans.length) continue;
      plans.sort((a, b) => (a.price_per_month ?? 0) - (b.price_per_month ?? 0));
      const plan     = plans[0];
      const gpuCount = plan.gpu_count ?? 1;
      const monthly  = plan.price_per_month ?? plan.monthly_cost ?? 0;
      const hourly   = monthly / 730 / gpuCount;
      if (hourly > 0) return ok(hourly, { id: plan.id, gpu_type: plan.gpu_type, gpu_count: gpuCount });
    }
    // Fallback: pricing page
    const pageRes = await fetchT('https://www.vultr.com/pricing/cloud-gpu/');
    if (pageRes.ok) {
      const html  = await pageRes.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: 'vultr-pricing-page' });
    }
    return null;
  } catch (e) { console.error('[scraper] Vultr:', e.message); return null; }
}

// ─────────────────────────────────────────────
// HYPERSTACK (Nexgen Cloud)
// Tries their GPU availability API and pricing page.
// ─────────────────────────────────────────────
export async function scrapeHyperstack() {
  try {
    // Hyperstack public flavors/pricing API (no auth for public catalog)
    const apiUrls = [
      'https://infrahub-api.nexgencloud.com/v1/core/flavors',
      'https://infrahub-api.nexgencloud.com/v1/core/gpu-availabilities',
      'https://infrahub-api.nexgencloud.com/v1/core/flavors/available-resources',
      'https://api.hyperstack.cloud/v1/core/flavors',
      'https://api.hyperstack.cloud/v1/core/gpu-availabilities',
    ];
    for (const apiUrl of apiUrls) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data;
      try { data = await res.json(); } catch { continue; }
      // Flatten nested response shapes
      const entries = Array.isArray(data) ? data
        : Array.isArray(data?.data)      ? data.data
        : Array.isArray(data?.flavors)   ? data.flavors
        : Object.values(data?.data ?? data ?? {});
      for (const g of entries) {
        const name = (g.gpu_name ?? g.name ?? g.flavor_name ?? g.gpu_model ?? '').toLowerCase();
        if (!name.includes('h100')) continue;
        if (name.includes('pcie')) continue;
        // Price fields vary across API versions
        const price = g.price_per_hour ?? g.hourly_price ?? g.on_demand_price
                   ?? g.prices?.on_demand ?? g.price ?? g.cost;
        if (price && +price > 0) return ok(+price, { name, apiUrl });
      }
    }
    // Fallback: pricing page (Hyperstack uses React, but may have SSR or __NEXT_DATA__)
    for (const url of [
      'https://www.hyperstack.cloud/gpu-cloud',
      'https://www.hyperstack.cloud/pricing',
      'https://hyperstack.cloud',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed, 1.0, 15);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html, 1.0, 15);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Hyperstack:', e.message); return null; }
}

// ─────────────────────────────────────────────
// GMI CLOUD
// Public pricing page / marketplace.
// ─────────────────────────────────────────────
export async function scrapeGMICloud() {
  try {
    // GMI Cloud domain is gmi.ai (not gmi.cloud)
    for (const url of [
      'https://gmi.ai/pricing',
      'https://www.gmi.ai/pricing',
      'https://gmi.ai/gpu-cloud',
      'https://gmi.ai',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] GMI Cloud:', e.message); return null; }
}

// ─────────────────────────────────────────────
// COREWEAVE
// Pricing page: coreweave.com/gpu-cloud-compute-pricing
// H100 SXM5 NVLink listed publicly.
// ─────────────────────────────────────────────
export async function scrapeCoreweve() {
  try {
    for (const url of [
      'https://www.coreweave.com/gpu-cloud-compute-pricing',
      'https://www.coreweave.com/pricing',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      // Look for SXM5/NVLink H100 price in embedded JSON first
      if (embed) {
        const nvMatch = embed.match(/(?:SXM5|NVLink)[^"]{0,200}([\d]+\.[\d]{1,2})/i)
                     ?? embed.match(/([\d]+\.[\d]{1,2})[^"]{0,100}(?:SXM5|NVLink)/i);
        if (nvMatch) {
          const p = parseFloat(nvMatch[1]);
          if (p >= 0.5 && p <= 20) return ok(p, { source: url + '+json-nvlink' });
        }
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      // Direct HTML scan
      const nvMatch = html.match(/(?:SXM5|NVLink)[^<]{0,400}\$\s*([\d]+\.[\d]{1,2})/i)
                   ?? html.match(/\$\s*([\d]+\.[\d]{1,2})[^<]{0,200}(?:SXM5|NVLink)/i);
      if (nvMatch) {
        const p = parseFloat(nvMatch[1]);
        if (p >= 0.5 && p <= 20) return ok(p, { source: url + '-nvlink' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] CoreWeave:', e.message); return null; }
}

// ─────────────────────────────────────────────
// TENSORDOCK
// Marketplace API — tries multiple response formats.
// ─────────────────────────────────────────────
export async function scrapeTensorDock() {
  try {
    // TensorDock public marketplace API — lists all available host nodes
    for (const apiUrl of [
      'https://marketplace.tensordock.com/api/v0/client/deploy/hostnodes',
      'https://tensordock.com/api/v0/client/deploy/hostnodes',
    ]) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data;
      try { data = JSON.parse(await res.text()); } catch { continue; }

      const nodeMap  = data?.hostnodes ?? data?.nodes ?? data;
      const nodeList = Array.isArray(nodeMap) ? nodeMap : Object.values(nodeMap ?? {});
      const prices   = [];

      for (const node of nodeList) {
        // GPU specs can be nested under specs.gpu or directly under gpus/gpu
        const gpuSpecs = node?.specs?.gpu ?? node?.gpus ?? node?.gpu ?? {};
        const entries  = typeof gpuSpecs === 'object' && !Array.isArray(gpuSpecs)
          ? Object.entries(gpuSpecs)
          : Array.isArray(gpuSpecs) ? gpuSpecs.map(g => [g.model ?? g.name, g]) : [];

        for (const [model, info] of entries) {
          if (typeof model !== 'string') continue;
          if (!model.toLowerCase().includes('h100')) continue;
          // Accept SXM and non-PCIe variants
          const mLow = model.toLowerCase();
          // price can be at top level or nested
          const p = typeof info === 'number' ? info
                  : info?.price ?? info?.price_per_gpu ?? info?.hourly ?? info?.cost;
          if (typeof p === 'number' && p > 0.5 && p < 20) prices.push(p);
        }
      }
      if (prices.length) {
        prices.sort((a, b) => a - b);
        return ok(prices[Math.floor(prices.length / 2)], { offerCount: prices.length });
      }
    }
    // Fallback: pricing page
    for (const url of ['https://tensordock.com/pricing', 'https://marketplace.tensordock.com']) {
      const pageRes = await fetchT(url);
      if (!pageRes.ok) continue;
      const html  = await pageRes.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] TensorDock:', e.message); return null; }
}

// ─────────────────────────────────────────────
// NEBIUS  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeNebius() {
  try {
    // Nebius public pricing API (they spun off from Yandex Cloud)
    for (const apiUrl of [
      'https://storage.api.nebius.cloud/billing/v1/prices',
      'https://api.nebius.cloud/v1/billing/prices',
    ]) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data; try { data = await res.json(); } catch { continue; }
      const items = data?.prices ?? data?.items ?? data ?? [];
      const list  = Array.isArray(items) ? items : Object.values(items);
      const h100  = list.find(i => {
        const n = (i.description ?? i.name ?? i.sku ?? '').toLowerCase();
        return n.includes('h100') && !n.includes('pcie');
      });
      const price = h100?.price_per_hour ?? h100?.unit_price ?? h100?.price;
      if (price && +price > 0) return ok(+price, h100);
    }
    // Pricing pages
    for (const url of [
      'https://nebius.com/prices/compute',
      'https://nebius.com/il1/prices/compute',
      'https://nebius.com/pricing',
      'https://nebius.ai/pricing',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html, 1.0, 20);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Nebius:', e.message); return null; }
}

// ─────────────────────────────────────────────
// THUNDER COMPUTE  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeThunderCompute() {
  try {
    for (const url of ['https://thundercompute.com/pricing', 'https://thundercompute.com']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Thunder Compute:', e.message); return null; }
}

// ─────────────────────────────────────────────
// JARVISLABS  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeJarvislabs() {
  try {
    for (const url of [
      'https://jarvislabs.ai/pricing',
      'https://jarvislabs.ai/instances/',
      'https://jarvislabs.ai',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Jarvislabs:', e.message); return null; }
}

// ─────────────────────────────────────────────
// NOVITA AI  — public API + pricing page.
// ─────────────────────────────────────────────
export async function scrapeNovitaAI() {
  try {
    // Try public GPU instance API
    const apiUrls = [
      'https://api.novita.ai/v3/gpu-instance/list_available_resources',
      'https://api.novita.ai/v3/gpu-instance/list_instances',
    ];
    for (const apiUrl of apiUrls) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const gpus = data.gpus ?? data.instances ?? data.resources ?? data ?? [];
      const list = Array.isArray(gpus) ? gpus : Object.values(gpus);
      const h100 = list.find(g => (g.gpu_name ?? g.name ?? '').includes('H100'));
      const price = h100?.price_per_hour ?? h100?.hourly_price ?? h100?.price;
      if (price && price > 0) return ok(price, h100);
    }
    // Fallback: pricing page
    for (const url of ['https://novita.ai/gpu-instance', 'https://novita.ai/pricing']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Novita AI:', e.message); return null; }
}

// ─────────────────────────────────────────────
// OBLIVUS  (PCIe H100)  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeOblivus() {
  try {
    for (const url of ['https://oblivus.com/gpu-pricing', 'https://oblivus.com/pricing', 'https://oblivus.com']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Oblivus:', e.message); return null; }
}

// ─────────────────────────────────────────────
// FLUIDSTACK  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeFluidStack() {
  try {
    // FluidStack public GPU configurations API
    for (const apiUrl of [
      'https://api.fluidstack.io/v1/gpu-configurations',
      'https://api.fluidstack.io/v1/plans',
      'https://api.fluidstack.io/v1/instances',
    ]) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data; try { data = await res.json(); } catch { continue; }
      const items = data?.gpu_configurations ?? data?.plans ?? data?.instances ?? data ?? [];
      const list  = Array.isArray(items) ? items : Object.values(items);
      const h100  = list.find(g => {
        const n = (g.gpu_model ?? g.gpu ?? g.name ?? '').toLowerCase();
        return n.includes('h100') && !n.includes('pcie');
      });
      const price = h100?.hourly_price ?? h100?.price ?? h100?.price_per_hour;
      if (price && +price > 0) return ok(+price, h100);
    }
    // Pricing pages
    for (const url of [
      'https://www.fluidstack.io/pricing',
      'https://fluidstack.io/pricing',
      'https://fluidstack.io',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html, 1.0, 15);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] FluidStack:', e.message); return null; }
}

// ─────────────────────────────────────────────
// CUDO COMPUTE
// REST API: rest.compute.cudo.org — tries multiple endpoints.
// Falls back to pricing page.
// ─────────────────────────────────────────────
export async function scrapeCUDO() {
  try {
    // CUDO Compute public REST API
    for (const apiUrl of [
      'https://rest.compute.cudo.org/v1/vms/machine-types',
      'https://rest.compute.cudo.org/v1/machine-types',
      'https://rest.compute.cudo.org/v1/instance-types',
      'https://rest.compute.cudo.org/v1/gpus',
      'https://rest.compute.cudo.org/v1/regions/us-central1-a/machine-types',
    ]) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data; try { data = await res.json(); } catch { continue; }
      const items = data.machineTypes ?? data.machine_types ?? data.instanceTypes ?? data.gpus ?? data ?? [];
      const list  = Array.isArray(items) ? items : Object.values(items);
      const h100  = list.find(t => {
        const n = (t.gpu ?? t.gpu_model ?? t.gpu_type ?? t.name ?? t.description ?? '').toLowerCase();
        return n.includes('h100') && !n.includes('pcie');
      });
      const price = h100?.price_per_gpu_hr ?? h100?.gpu_price ?? h100?.price_hr
                 ?? h100?.price_per_hour   ?? h100?.hourly_price ?? h100?.price;
      if (price && +price > 0) return ok(+price, h100);
    }
    // Fallback: pricing page
    for (const url of [
      'https://www.cudocompute.com/pricing',
      'https://compute.cudo.org/pricing',
      'https://compute.cudo.org',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] CUDO Compute:', e.message); return null; }
}

// ─────────────────────────────────────────────
// VERDA  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeVerda() {
  try {
    // Try Verda API endpoints
    for (const apiUrl of [
      'https://api.verda.cloud/v1/pricing',
      'https://api.verda.cloud/v1/instances',
      'https://verda.cloud/api/pricing',
    ]) {
      const res = await fetchT(apiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      let data; try { data = await res.json(); } catch { continue; }
      const items = data?.instances ?? data?.pricing ?? data ?? [];
      const list  = Array.isArray(items) ? items : Object.values(items);
      const h100  = list.find(i => (i.gpu ?? i.name ?? '').toLowerCase().includes('h100'));
      const price = h100?.price_per_hour ?? h100?.hourly_price ?? h100?.price;
      if (price && +price > 0) return ok(+price, h100);
    }
    for (const url of [
      'https://verda.cloud/pricing',
      'https://verda.cloud/gpu-cloud',
      'https://verda.cloud',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Verda:', e.message); return null; }
}

// ─────────────────────────────────────────────
// CIVO  (PCIe H100)  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeCivo() {
  try {
    for (const url of ['https://www.civo.com/gpu', 'https://www.civo.com/pricing']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Civo:', e.message); return null; }
}

// ─────────────────────────────────────────────
// SCALEWAY  — pricing page.
// Requests the US-facing English page; Vercel's US origin often gets USD.
// h100Price() now matches € as well as $ so EUR pricing is handled.
// ─────────────────────────────────────────────
export async function scrapeScaleway() {
  try {
    for (const url of [
      'https://www.scaleway.com/en/pricing/gpu-instances/',
      'https://www.scaleway.com/en/gpu-instances/',
    ]) {
      const res = await fetchT(url, {
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Scaleway:', e.message); return null; }
}

// ─────────────────────────────────────────────
// OVH  — pricing page (tries multiple URL patterns).
// ─────────────────────────────────────────────
export async function scrapeOVH() {
  try {
    for (const url of [
      'https://www.ovhcloud.com/en/public-cloud/gpu/',
      'https://www.ovhcloud.com/en/public-cloud/prices/',
      'https://www.ovhcloud.com/en-us/public-cloud/gpu/',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] OVH:', e.message); return null; }
}

// ─────────────────────────────────────────────
// SESTERCE  — pricing page (EUR provider; h100Price handles € symbol).
// ─────────────────────────────────────────────
export async function scrapeSesterce() {
  try {
    // Sesterce is a French provider — prices in EUR; h100Price handles € symbol
    for (const url of [
      'https://sesterce.io/pricing',
      'https://sesterce.io/gpu-cloud',
      'https://sesterce.io',
      'https://sesterce.com/pricing',
      'https://sesterce.com',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Sesterce:', e.message); return null; }
}

// ─────────────────────────────────────────────
// KOYEB  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeKoyeb() {
  try {
    for (const url of ['https://www.koyeb.com/pricing', 'https://www.koyeb.com/docs/reference/instances']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Koyeb:', e.message); return null; }
}

// ─────────────────────────────────────────────
// TOGETHER AI  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeTogetherAI() {
  try {
    for (const url of ['https://www.together.ai/pricing', 'https://api.together.ai/pricing']) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Together AI:', e.message); return null; }
}

// ─────────────────────────────────────────────
// DIGITALOCEAN  — GPU Droplets pricing page.
// ─────────────────────────────────────────────
export async function scrapeDigitalOcean() {
  try {
    for (const url of [
      'https://www.digitalocean.com/pricing/gpu-droplets',
      'https://www.digitalocean.com/pricing',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] DigitalOcean:', e.message); return null; }
}

// ─────────────────────────────────────────────
// PAPERSPACE  (PCIe H100)  — pricing page.
// ─────────────────────────────────────────────
export async function scrapePaperspace() {
  try {
    for (const url of [
      'https://www.paperspace.com/pricing',
      'https://www.paperspace.com/gpu-cloud',
      'https://www.digitalocean.com/products/paperspace',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Paperspace:', e.message); return null; }
}

// ─────────────────────────────────────────────
// GCORE  — pricing page.
// ─────────────────────────────────────────────
export async function scrapeGcore() {
  try {
    for (const url of [
      'https://gcore.com/cloud/gpu',
      'https://gcore.com/pricing/cloud',
      'https://gcore.com/cloud/virtual-instances',
    ]) {
      const res = await fetchT(url);
      if (!res.ok) continue;
      const html  = await res.text();
      const embed = embeddedJsonText(html);
      if (embed) {
        const p = h100Price(embed);
        if (p) return ok(p, { source: url + '+json' });
      }
      const price = h100Price(html);
      if (price) return ok(price, { source: url });
    }
    return null;
  } catch (e) { console.error('[scraper] Gcore:', e.message); return null; }
}

// ─────────────────────────────────────────────
// SCRAPER MAP
// Every provider is mapped — no "skipped" entries in scrape results.
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
