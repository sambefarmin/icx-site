import { createClient } from '@supabase/supabase-js';

// Uses the SERVICE ROLE key – never expose this on the frontend.
// Set these as environment variables in your Vercel project settings.
const supabaseUrl    = process.env.SUPABASE_URL;
const supabaseKey    = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});
