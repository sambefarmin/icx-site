-- ============================================================
-- Add website column to providers + update latest_prices view
-- ============================================================

-- 1. Add website column
ALTER TABLE providers ADD COLUMN IF NOT EXISTS website TEXT;

-- 2. Seed website URLs for all known providers
UPDATE providers SET website = 'https://aws.amazon.com/ec2/instance-types/p5/'                     WHERE name = 'AWS (p5)';
UPDATE providers SET website = 'https://cloud.google.com/compute/docs/gpus'                       WHERE name = 'Google Cloud (a3)';
UPDATE providers SET website = 'https://learn.microsoft.com/en-us/azure/virtual-machines/nca100v4-series' WHERE name = 'Azure (NC H100)';
UPDATE providers SET website = 'https://lambdalabs.com/service/gpu-cloud'                         WHERE name = 'Lambda Labs';
UPDATE providers SET website = 'https://www.runpod.io/gpu-instance/pricing'                       WHERE name = 'RunPod (Secure)';
UPDATE providers SET website = 'https://www.runpod.io/gpu-instance/pricing'                       WHERE name = 'RunPod (Community)';
UPDATE providers SET website = 'https://www.hyperstack.cloud'                                      WHERE name = 'Hyperstack';
UPDATE providers SET website = 'https://gmi.ai'                                                    WHERE name = 'GMI Cloud';
UPDATE providers SET website = 'https://www.coreweave.com/gpu-cloud-computing'                    WHERE name = 'CoreWeave';
UPDATE providers SET website = 'https://tensordock.com'                                            WHERE name = 'TensorDock';
UPDATE providers SET website = 'https://vast.ai'                                                   WHERE name = 'Vast.ai';
UPDATE providers SET website = 'https://nebius.com/services/compute'                              WHERE name = 'Nebius';
UPDATE providers SET website = 'https://thundercompute.com'                                        WHERE name = 'Thunder Compute';
UPDATE providers SET website = 'https://jarvislabs.ai'                                             WHERE name = 'Jarvislabs';
UPDATE providers SET website = 'https://novita.ai'                                                 WHERE name = 'Novita AI';
UPDATE providers SET website = 'https://oblivus.com'                                               WHERE name = 'Oblivus';
UPDATE providers SET website = 'https://www.fluidstack.io'                                         WHERE name = 'FluidStack';
UPDATE providers SET website = 'https://www.cudocompute.com'                                       WHERE name = 'CUDO Compute';
UPDATE providers SET website = 'https://verda.cloud'                                               WHERE name = 'Verda';
UPDATE providers SET website = 'https://www.civo.com/gpu'                                          WHERE name = 'Civo';
UPDATE providers SET website = 'https://www.ovhcloud.com/en/public-cloud/gpu/'                    WHERE name = 'OVH';
UPDATE providers SET website = 'https://www.scaleway.com/en/gpu-instances/'                       WHERE name = 'Scaleway';
UPDATE providers SET website = 'https://sesterce.io'                                               WHERE name = 'Sesterce';
UPDATE providers SET website = 'https://www.koyeb.com'                                             WHERE name = 'Koyeb';
UPDATE providers SET website = 'https://www.together.ai/products#inference'                       WHERE name = 'Together AI';
UPDATE providers SET website = 'https://www.digitalocean.com/products/gpu-droplets'               WHERE name = 'DigitalOcean';
UPDATE providers SET website = 'https://www.paperspace.com/gpu-cloud'                             WHERE name = 'Paperspace';
UPDATE providers SET website = 'https://gcore.com/cloud/gpu'                                       WHERE name = 'Gcore';
UPDATE providers SET website = 'https://www.vultr.com/products/cloud-gpu/'                        WHERE name = 'Vultr';
UPDATE providers SET website = 'https://crusoe.ai'                                                 WHERE name = 'Crusoe';

-- 3. Recreate latest_prices view to include website
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (ps.provider_id)
  ps.id,
  ps.provider_id,
  p.name,
  p.tier,
  p.tier_class,
  p.config,
  p.website,
  ps.price_usd,
  ps.is_available,
  ps.gpu_type,
  ps.scraped_at
FROM price_snapshots ps
JOIN providers p ON ps.provider_id = p.id
WHERE p.is_active = true
ORDER BY ps.provider_id, ps.scraped_at DESC;
