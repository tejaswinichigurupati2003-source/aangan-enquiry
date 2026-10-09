import { Store } from './store.js';
import { SupabaseStore } from './supabase.js';
import { dataDir } from './config.js';

export const storageBackend = (cfg) => cfg.env.STORAGE_BACKEND || cfg.storage?.backend || 'json';

/**
 * Open the configured store.
 *   json     → data/runtime/db.json (default; nothing leaves the machine)
 *   supabase → SupabaseStore (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env)
 */
export async function openStore(cfg, { dir, fetchImpl } = {}) {
  if (storageBackend(cfg) === 'supabase') return new SupabaseStore(cfg, { fetchImpl }).load();
  return new Store(dir ?? dataDir(cfg));
}

/** Persist and shut down cleanly (flushes pending Supabase writes). */
export async function closeStore(store) {
  if (typeof store.drain === 'function') await store.drain();
  else store.save();
}
