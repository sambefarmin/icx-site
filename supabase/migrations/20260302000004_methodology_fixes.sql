-- ============================================================
-- Methodology fixes
-- 1. Add gpu_variant column to providers (SXM5 vs PCIe)
-- 2. Normalize all price_snapshots.gpu_type strings
-- 3. Recreate latest_prices view exposing gpu_variant
-- ============================================================

-- 1. Add gpu_variant column — 'SXM5' for NVLink/SXM/SXM5, 'PCIe' for PCIe
ALTER TABLE providers ADD COLUMN IF NOT EXISTS gpu_variant TEXT NOT NULL DEFAULT 'SXM5';

-- Mark the five PCIe H100 providers
UPDATE providers
SET gpu_variant = 'PCIe'
WHERE name IN (
  'Lambda Labs',
  'RunPod (Community)',
  'Civo',
  'Paperspace',
  'Oblivus'
);

-- 2. Normalize gpu_type strings in price_snapshots
--    Old seed used 'H100 80GB' for everything — split by variant

UPDATE price_snapshots
SET gpu_type = 'H100 SXM5 80GB'
WHERE provider_id IN (
  SELECT id FROM providers WHERE gpu_variant = 'SXM5'
);

UPDATE price_snapshots
SET gpu_type = 'H100 PCIe 80GB'
WHERE provider_id IN (
  SELECT id FROM providers WHERE gpu_variant = 'PCIe'
);

-- 3. Recreate latest_prices view to expose gpu_variant
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (ps.provider_id)
  ps.id,
  ps.provider_id,
  p.name,
  p.tier,
  p.tier_class,
  p.config,
  p.website,
  p.gpu_variant,
  ps.price_usd,
  ps.is_available,
  ps.gpu_type,
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;
