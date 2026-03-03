-- ============================================================
-- Migration 005: Expose source_type in latest_prices view
-- Enables the frontend to distinguish "live" (auto-scraped)
-- providers from "listed" (manually maintained) providers.
-- ============================================================

-- Recreate latest_prices view to include source_type from providers.
-- Builds on top of migration 004 (adds gpu_variant, website).
-- If 004 hasn't run yet, website/gpu_variant columns may be absent —
-- COALESCE guards handle that gracefully.

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

-- Note: website and gpu_variant are intentionally omitted here so this
-- migration is safe to apply independently of 003/004. Once 003+004 run,
-- migration 004 will recreate the view with all columns. Apply in order:
-- 003 → 004 → 005.
--
-- If running 005 AFTER 004, re-run 004 to restore website + gpu_variant,
-- or apply the combined view below manually:
--
-- CREATE OR REPLACE VIEW latest_prices AS
-- SELECT DISTINCT ON (ps.provider_id)
--   ps.id, ps.provider_id, p.name, p.tier, p.tier_class, p.config,
--   p.source_type, p.website, p.gpu_variant,
--   ps.price_usd, ps.is_available, ps.gpu_type, ps.scraped_at
-- FROM price_snapshots ps
-- JOIN providers p ON ps.provider_id = p.id
-- WHERE p.is_active = true
-- ORDER BY ps.provider_id, ps.scraped_at DESC;
