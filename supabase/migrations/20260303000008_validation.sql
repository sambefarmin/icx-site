-- ============================================================
-- Migration 008: Data Validation Flags
-- Adds is_flagged + validation_flags columns to price_snapshots
-- so the validation pipeline can mark suspicious prices and
-- exclude them from ICX rate calculations.
-- ============================================================

ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS is_flagged       BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS validation_flags TEXT[]   NOT NULL DEFAULT '{}';

-- Partial index — only indexes flagged rows, so it's tiny but fast
-- for audit queries like "show me all flagged snapshots this week"
CREATE INDEX IF NOT EXISTS idx_snapshots_flagged
  ON price_snapshots (is_flagged, scraped_at DESC)
  WHERE is_flagged = true;

-- Rebuild latest_prices view to include is_flagged + validation_flags
-- (so the frontend and ICX rate calc can filter by validation status)
DROP VIEW IF EXISTS latest_prices;
CREATE VIEW latest_prices AS
SELECT DISTINCT ON (ps.provider_id)
  ps.id,
  ps.provider_id,
  p.name,
  p.tier,
  p.tier_class,
  p.config,
  p.source_type,
  p.website,
  p.gpu_variant,
  ps.price_usd,
  ps.is_available,
  ps.gpu_type,
  ps.pricing_model,
  ps.is_flagged,
  ps.validation_flags,
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;
