-- ============================================================
-- Migration 006: Mark all providers as source_type = 'api'
-- Every provider now has an automated scraper. Flip source_type
-- from 'manual' to 'api' so the frontend shows the live freshness
-- badge (green/orange/red) instead of the grey "Listed" badge.
-- ============================================================

UPDATE providers
SET source_type = 'api'
WHERE name IN (
  -- Previously manual, now have scrapers:
  'AWS (p5)',
  'Google Cloud (a3)',
  'CoreWeave',
  'GMI Cloud',
  'Hyperstack',
  'TensorDock',
  'Nebius',
  'Thunder Compute',
  'Jarvislabs',
  'Novita AI',
  'Oblivus',
  'FluidStack',
  'CUDO Compute',
  'Verda',
  'Civo',
  'OVH',
  'Scaleway',
  'Sesterce',
  'Koyeb',
  'Together AI',
  'DigitalOcean',
  'Paperspace',
  'Gcore',
  'Vultr'
);

-- Recreate latest_prices view to include source_type (combines 005 + 004 + 003)
-- Apply this AFTER migrations 003 and 004 have run (for website + gpu_variant).
-- If 003/004 haven't run yet, run this view update manually after they do.
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (ps.provider_id)
  ps.id,
  ps.provider_id,
  p.name,
  p.tier,
  p.tier_class,
  p.config,
  p.source_type,
  ps.price_usd,
  ps.is_available,
  ps.gpu_type,
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;
