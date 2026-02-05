import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

export const getSupabaseClient = () => {
  if (cachedClient) return cachedClient;
  const url =
    process.env.SUPABASE_URL ||
    (process.env.SUPABASE_PROJECT_ID
      ? `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`
      : "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return null;
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cachedClient;
};

export const getSupabasePublicClient = () => {
  const url =
    process.env.SUPABASE_URL ||
    (process.env.SUPABASE_PROJECT_ID
      ? `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`
      : "");
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return null;
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false },
  });
};
