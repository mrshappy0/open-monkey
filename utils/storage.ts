import { storage } from '#imports';

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
