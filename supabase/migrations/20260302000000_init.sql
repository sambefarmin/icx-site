-- ============================================================
-- ICX Site - Supabase Database Schema
-- Run this in your Supabase SQL Editor (Project > SQL Editor)
-- ============================================================

-- 1. PROVIDERS table (reference data for each GPU cloud provider)
CREATE TABLE IF NOT EXISTS providers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  tier        TEXT NOT NULL CHECK (tier IN ('Hyperscaler', 'Specialist', 'Marketplace')),
  tier_class  TEXT NOT NULL DEFAULT 'tier-spec',
  config      TEXT NOT NULL DEFAULT 'SXM5 80GB',
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('api', 'manual')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. PRICE_SNAPSHOTS table (one row per provider per scrape run)
CREATE TABLE IF NOT EXISTS price_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  provider_id  INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  price_usd    DECIMAL(10, 4) NOT NULL CHECK (price_usd > 0),
  is_available BOOLEAN NOT NULL DEFAULT true,
  gpu_type     TEXT NOT NULL DEFAULT 'H100 SXM5 80GB',
  region       TEXT,
  scraped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data     JSONB
);

-- 3. ICX_RATE_HISTORY table (pre-computed trimmed mean stored each scrape)
CREATE TABLE IF NOT EXISTS icx_rate_history (
  id             BIGSERIAL PRIMARY KEY,
  rate           DECIMAL(10, 4) NOT NULL,
  provider_count INTEGER NOT NULL,
  min_price      DECIMAL(10, 4),
  max_price      DECIMAL(10, 4),
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_snapshots_provider_scraped
  ON price_snapshots(provider_id, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_scraped_at
  ON price_snapshots(scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_icx_history_computed_at
  ON icx_rate_history(computed_at DESC);

-- 5. View: latest price per active provider (used by the frontend)
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (ps.provider_id)
  ps.id,
  ps.provider_id,
  p.name,
  p.tier,
  p.tier_class,
  p.config,
  ps.price_usd,
  ps.is_available,
  ps.gpu_type,
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;

-- 6. Row Level Security (allow public reads, service role writes)
ALTER TABLE providers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE icx_rate_history  ENABLE ROW LEVEL SECURITY;

-- Public read policies (anon key is safe for reads)
CREATE POLICY "public_read_providers"
  ON providers FOR SELECT USING (true);

CREATE POLICY "public_read_snapshots"
  ON price_snapshots FOR SELECT USING (true);

CREATE POLICY "public_read_icx_history"
  ON icx_rate_history FOR SELECT USING (true);

-- Service role write policies (only your scraper/API can write)
CREATE POLICY "service_write_providers"
  ON providers FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_write_snapshots"
  ON price_snapshots FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_write_icx_history"
  ON icx_rate_history FOR ALL USING (auth.role() = 'service_role');

-- 7. Seed initial providers
INSERT INTO providers (name, tier, tier_class, config, source_type) VALUES
  ('AWS (p5)',           'Hyperscaler', 'tier-hyper', 'SXM5 80GB', 'manual'),
  ('Google Cloud (a3)', 'Hyperscaler', 'tier-hyper', 'SXM5 80GB', 'manual'),
  ('Azure (NC H100)',   'Hyperscaler', 'tier-hyper', 'SXM5 80GB', 'api'),
  ('Lambda Labs',       'Specialist',  'tier-spec',  'SXM5 80GB', 'api'),
  ('CoreWeave',         'Specialist',  'tier-spec',  'SXM5 80GB', 'manual'),
  ('Crusoe',            'Specialist',  'tier-spec',  'SXM5 80GB', 'manual'),
  ('Voltage Park',      'Specialist',  'tier-spec',  'SXM5 80GB', 'manual'),
  ('Prime Intellect',   'Specialist',  'tier-spec',  'SXM5 80GB', 'manual'),
  ('Hyperstack',        'Specialist',  'tier-spec',  'SXM5 80GB', 'manual'),
  ('Vast.ai',           'Marketplace', 'tier-mkt',   'SXM5 80GB', 'api'),
  ('RunPod',            'Marketplace', 'tier-mkt',   'SXM5 80GB', 'api'),
  ('Novita AI',         'Marketplace', 'tier-mkt',   'SXM5 80GB', 'manual'),
  ('DataCrunch',        'Marketplace', 'tier-mkt',   'SXM5 80GB', 'manual'),
  ('TensorDock',        'Marketplace', 'tier-mkt',   'SXM5 80GB', 'manual')
ON CONFLICT (name) DO NOTHING;
