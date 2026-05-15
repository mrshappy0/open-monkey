import { storage } from '#imports';

export interface Settings {
  maxRetries: number;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: { maxRetries: 3 },
  version: 1,
});

export interface UserScript {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
}

// Typed, versioned storage item — WXT handles serialization, fallback, and
// future migration hooks via the `version` + `migrations` options.
export const scriptsItem = storage.defineItem<UserScript[]>('local:scripts', {
  fallback: [],
  version: 1,
});

export interface ScriptStoreEntry {
  value: unknown;
  secret: boolean;
  updatedAt: number;
}

export type ScriptStore = Record<string, Record<string, ScriptStoreEntry>>;

export const scriptStoreItem = storage.defineItem<ScriptStore>('local:script-store', {
  fallback: {},
  version: 1,
});
