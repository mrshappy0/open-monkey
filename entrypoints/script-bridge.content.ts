/**
 * script-bridge — general-purpose content script bridge between the USER_SCRIPT
 * world and chrome.storage.local (via scriptStoreItem).
 *
 * Userscripts cannot access chrome.storage directly. This content script runs
 * in the extension context (with storage access) and handles reads/writes on
 * their behalf via window CustomEvents.
 *
 * Security note: window CustomEvents are visible to page-level JavaScript on
 * the same origin. Values stored in chrome.storage.local are safe at rest
 * (extension-only API access), but the event channel is shared with the page.
 * Do not store credentials on pages you do not control.
 *
 * Events in:
 *   om-store-getall  { requestId, namespace }
 *   om-store-get     { requestId, namespace, key }
 *   om-store-set     { namespace, key, value, secret? }
 *   om-store-delete  { namespace, key }
 *
 * Events out:
 *   om-store-getall-result  { requestId, data: Record<string, unknown> }
 *   om-store-value          { requestId, value: unknown }
 */

import { scriptStoreItem } from '../utils/storage';

interface StoreGetAllDetail  { requestId: string; namespace: string; }
interface StoreGetDetail     { requestId: string; namespace: string; key: string; }
interface StoreSetDetail     { namespace: string; key: string; value: unknown; secret?: boolean; }
interface StoreSetManyDetail { namespace: string; patch: Record<string, { value: unknown; secret: boolean }>; }
interface StoreDeleteDetail  { namespace: string; key: string; }
interface StoreListDetail    { requestId: string; namespace: string; }

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    window.addEventListener('om-store-getall', async (e: Event) => {
      const { requestId, namespace } = (e as CustomEvent<StoreGetAllDetail>).detail;
      const store = await scriptStoreItem.getValue();
      const ns = store[namespace] ?? {};
      const data: Record<string, unknown> = {};
      for (const [k, entry] of Object.entries(ns)) data[k] = entry.value;
      window.dispatchEvent(new CustomEvent('om-store-getall-result', { detail: { requestId, data } }));
    });

    window.addEventListener('om-store-get', async (e: Event) => {
      const { requestId, namespace, key } = (e as CustomEvent<StoreGetDetail>).detail;
      const store = await scriptStoreItem.getValue();
      const value = store[namespace]?.[key]?.value ?? undefined;
      window.dispatchEvent(new CustomEvent('om-store-value', { detail: { requestId, value } }));
    });

    window.addEventListener('om-store-set', async (e: Event) => {
      const { namespace, key, value, secret = false } = (e as CustomEvent<StoreSetDetail>).detail;
      const store = await scriptStoreItem.getValue();
      await scriptStoreItem.setValue({
        ...store,
        [namespace]: {
          ...(store[namespace] ?? {}),
          [key]: { value, secret, updatedAt: Date.now() },
        },
      });
    });

    window.addEventListener('om-store-list', async (e: Event) => {
      const { requestId, namespace } = (e as CustomEvent<StoreListDetail>).detail;
      const store = await scriptStoreItem.getValue();
      const keys = Object.keys(store[namespace] ?? {});
      window.dispatchEvent(new CustomEvent('om-store-list-result', { detail: { requestId, keys } }));
    });

    // Atomic multi-key write — avoids race conditions when saving several keys at once.
    window.addEventListener('om-store-setmany', async (e: Event) => {
      const { namespace, patch } = (e as CustomEvent<StoreSetManyDetail>).detail;
      const store = await scriptStoreItem.getValue();
      await scriptStoreItem.setValue({
        ...store,
        [namespace]: {
          ...(store[namespace] ?? {}),
          ...Object.fromEntries(
            Object.entries(patch).map(([k, { value, secret }]) => [
              k, { value, secret, updatedAt: Date.now() },
            ])
          ),
        },
      });
    });

    window.addEventListener('om-store-delete', async (e: Event) => {
      const { namespace, key } = (e as CustomEvent<StoreDeleteDetail>).detail;
      const store = await scriptStoreItem.getValue();
      if (!store[namespace]) return;
      const ns = { ...store[namespace] };
      delete ns[key];
      const updated = { ...store };
      if (Object.keys(ns).length === 0) {
        delete updated[namespace];
      } else {
        updated[namespace] = ns;
      }
      await scriptStoreItem.setValue(updated);
    });
  },
});
