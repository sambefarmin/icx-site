-- ============================================================
-- Seed real spot prices from H100 Provider & Price Feb 24 2026
-- Source: GetDeploying.com, captured 2026-02-24
-- On-demand, per-GPU prices only (no spot, no reservations)
-- ============================================================

-- ── 1. Add new providers not yet in the table ─────────────────
INSERT INTO providers (name, tier, tier_class, config, source_type) VALUES
  ('Novita AI',      'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Oblivus',        'Specialist',  'tier-spec',  'NVLink 80GB', 'manual'),
  ('FluidStack',     'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('CUDO Compute',   'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Verda',          'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('Civo',           'Specialist',  'tier-spec',  'PCIe 80GB',  'manual'),
  ('OVH',            'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Scaleway',       'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Sesterce',       'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Koyeb',          'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Together AI',    'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('DigitalOcean',   'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Paperspace',     'Specialist',  'tier-spec',  'PCIe 80GB',  'manual'),
  ('Gcore',          'Specialist',  'tier-spec',  'SXM 80GB',   'manual'),
  ('Vultr',          'Specialist',  'tier-spec',  'SXM 80GB',   'manual')
ON CONFLICT (name) DO UPDATE
  SET tier       = EXCLUDED.tier,
      tier_class = EXCLUDED.tier_class,
      config     = EXCLUDED.config;

-- ── 2. Insert price snapshots for all providers ───────────────
-- One snapshot per provider, timestamped at data capture date.
-- Uses subqueries so provider_id is resolved by name (safe).

INSERT INTO price_snapshots (provider_id, price_usd, is_available, gpu_type, region, raw_data)
SELECT p.id, v.price, true, 'H100 80GB', 'US',
       jsonb_build_object('source', 'GetDeploying.com', 'captured', '2026-02-24', 'billing_type', 'On-Demand', 'config', v.config)
FROM (VALUES
  -- ── Existing providers (updated to real prices) ──────────────
  ('AWS (p5)',           6.88,  '8x H100 SXM5 80GB On-Demand (p5.48xlarge), per GPU'),
  ('Google Cloud (a3)', 14.19, '1x H100 80GB On-Demand (a3-highgpu-1g)'),
  ('Azure (NC H100)',    6.98,  '1x H100 94GB On-Demand (NCadsH100v5)'),
  ('Lambda Labs',        2.49,  '1x H100 PCIe 80GB On-Demand'),
  ('RunPod (Secure)',    2.69,  '1x H100 SXM 80GB On-Demand'),
  ('RunPod (Community)', 1.99, '1x H100 PCIe 80GB On-Demand'),
  ('Hyperstack',         1.90,  '1x H100 80GB On-Demand'),
  ('CoreWeave',          6.16,  'HGX H100 8x On-Demand, per GPU'),
  ('Nebius',             2.95,  '1x H100 HGX 80GB On-Demand'),
  ('Thunder Compute',    1.89,  'H100 On-Demand'),
  ('Novita AI',          1.45,  '1x H100 SXM 80GB On-Demand'),
  ('Crusoe',             3.90,  'h100-80gb-sxm-ib.8x On-Demand, per GPU'),
  -- ── New providers ────────────────────────────────────────────
  ('Oblivus',            1.98,  'H100 80GB PCIe On-Demand'),
  ('FluidStack',         2.10,  'Nvidia H100 SXM On-Demand'),
  ('CUDO Compute',       2.25,  'H100 SXM On-Demand'),
  ('Verda',              2.29,  '1x H100 SXM5 80GB On-Demand'),
  ('Civo',               2.49,  '1x H100 PCIe 80GB On-Demand'),
  ('OVH',                2.99,  'h100-380 On-Demand'),
  ('Scaleway',           3.00,  'H100-1-80G On-Demand'),
  ('Sesterce',           3.15,  '1x H100 80GB On-Demand'),
  ('Koyeb',              3.30,  'H100 On-Demand'),
  ('Together AI',        3.36,  '1x H100 80GB On-Demand'),
  ('DigitalOcean',       3.39,  '1x H100 80GB On-Demand (gpu-h100x1-80gb)'),
  ('Paperspace',         5.99,  'H100 PCIe On-Demand'),
  ('Gcore',              3.28,  'H100 SXM x8 On-Demand, per GPU'),
  ('Vultr',              2.99,  '8x H100 HGX 80GB On-Demand, per GPU')
) AS v(name, price, config)
JOIN providers p ON p.name = v.name
WHERE p.is_active = true;

-- ── 3. Recompute ICX rate from all current prices ─────────────
WITH latest AS (
  SELECT DISTINCT ON (provider_id)
    price_usd
  FROM price_snapshots
  ORDER BY provider_id, scraped_at DESC
),
sorted AS (
  SELECT price_usd,
         ROW_NUMBER() OVER (ORDER BY price_usd) AS rn,
         COUNT(*)      OVER ()                   AS total
  FROM latest
),
trimmed AS (
  SELECT price_usd
  FROM sorted
  WHERE rn > FLOOR(total * 0.15)
    AND rn <= total - FLOOR(total * 0.15)
)
INSERT INTO icx_rate_history (rate, provider_count, min_price, max_price)
SELECT
  ROUND(AVG(price_usd)::numeric, 4),
  COUNT(*),
  ROUND(MIN(price_usd)::numeric, 4),
  ROUND(MAX(price_usd)::numeric, 4)
FROM trimmed;
