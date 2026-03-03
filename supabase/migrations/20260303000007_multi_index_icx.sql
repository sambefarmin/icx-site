-- ============================================================
-- Migration 007: Multi-Index ICX Rate History
-- Adds gpu_type column to icx_rate_history so each index
-- (H100 SXM5, H100 PCIe, A100, H200, L40S, etc.) can store
-- its own time series independently.
-- ============================================================

-- Add gpu_type to icx_rate_history (defaults to SXM5 to back-fill old rows)
ALTER TABLE icx_rate_history
  ADD COLUMN IF NOT EXISTS gpu_type TEXT NOT NULL DEFAULT 'H100 SXM5 80GB';

-- Index for efficient per-gpu_type time series queries
CREATE INDEX IF NOT EXISTS idx_icx_rate_history_gpu_type
  ON icx_rate_history (gpu_type, computed_at DESC);

-- Add pricing_model to price_snapshots to distinguish on-demand vs spot/marketplace
ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT 'on_demand'
  CHECK (pricing_model IN ('on_demand', 'spot', 'reserved'));

-- Recreate latest_prices view to expose gpu_type and pricing_model
-- (Combines all prior migrations 003 + 004 + 005 + 006)
CREATE OR REPLACE VIEW latest_prices AS
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
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;
