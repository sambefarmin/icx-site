-- ============================================================
-- Fix providers table to match the actual site provider list.
-- Clears the seed data and re-inserts the correct 14 providers.
-- ============================================================

-- Remove old seed rows (safe: no price_snapshots exist yet)
DELETE FROM providers;

-- Re-seed with the correct provider list matching index.html
INSERT INTO providers (name, tier, tier_class, config, source_type) VALUES
  ('AWS (p5)',            'Hyperscaler', 'tier-hyper', 'SXM5 80GB',  'manual'),
  ('Google Cloud (a3)',  'Hyperscaler', 'tier-hyper', 'SXM5 80GB',  'manual'),
  ('Azure (NC H100)',    'Hyperscaler', 'tier-hyper', 'SXM5 80GB',  'api'),
  ('Lambda Labs',        'Specialist',  'tier-spec',  'SXM5 80GB',  'api'),
  ('RunPod (Secure)',    'Specialist',  'tier-spec',  'SXM5 80GB',  'api'),
  ('Hyperstack',         'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('GMI Cloud',          'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('CoreWeave',          'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('TensorDock',         'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('Vast.ai',            'Marketplace', 'tier-mkt',   'SXM5 80GB',  'api'),
  ('Nebius',             'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('Thunder Compute',    'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('Jarvislabs',         'Specialist',  'tier-spec',  'SXM5 80GB',  'manual'),
  ('RunPod (Community)', 'Marketplace', 'tier-mkt',   'PCIe 80GB',  'api')
ON CONFLICT (name) DO UPDATE
  SET tier       = EXCLUDED.tier,
      tier_class = EXCLUDED.tier_class,
      config     = EXCLUDED.config,
      source_type= EXCLUDED.source_type;

-- Update scrapers.js SCRAPERS map to use 'RunPod (Secure)' and 'RunPod (Community)'
-- (reminder: update lib/scrapers.js SCRAPERS keys to match these names)
