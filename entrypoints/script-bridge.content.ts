/**
 * script-bridge — general-purpose content script bridge between the USER_SCRIPT
 * world and chrome.storage.local (via scriptStoreItem).
 *
 * Userscripts cannot access chrome.storage directly. This content script runs
 * in the extension context (with storage access) and handles reads/writes on
 * their behalf via window CustomEvents.
 *
 * Security model:
 *   USER_SCRIPT world scripts do not have access to chrome.* APIs, so window
 *   CustomEvents are the only available communication channel. This means event
 *   payloads (including values) are observable by page-level JavaScript on the
 *   same origin. chrome.storage.local is safe at rest (extension-only at rest),
 *   but the transit channel is shared with the page.
 *
 *   Mitigation: every incoming event is validated against the list of installed
 *   script IDs. Events whose namespace does not match a known script UUID are
 *   silently ignored, preventing page scripts from reading or writing arbitrary
 *   namespaces. Do not store credentials on pages you do not control.
 *
 * Events in:
 *   om-store-getall  { requestId, namespace }
 *   om-store-get     { requestId, namespace, key }
 *   om-store-set     { requestId, namespace, key, value, secret? }
 *   om-store-setmany { requestId, namespace, patch: Record<string, { value, secret }> }
 *   om-store-list    { requestId, namespace }
 *   om-store-delete  { requestId, namespace, key }
 *
 * Events out:
 *   om-store-getall-result  { requestId, data: Record<string, unknown> }
 *   om-store-value          { requestId, value: unknown }
 *   om-store-list-result    { requestId, keys: string[] }
 *   om-store-set-ack        { requestId }
 *   om-store-setmany-ack    { requestId }
 *   om-store-delete-ack     { requestId }
 */

import { scriptsItem, scriptStoreItem } from '../utils/storage';

interface StoreGetAllDetail  { requestId: string; namespace: string; }
interface StoreGetDetail     { requestId: string; namespace: string; key: string; }
interface StoreSetDetail     { requestId: string; namespace: string; key: string; value: unknown; secret?: boolean; }
interface StoreSetManyDetail { requestId: string; namespace: string; patch: Record<string, { value: unknown; secret: boolean }>; }
interface StoreDeleteDetail  { requestId: string; namespace: string; key: string; }
interface StoreListDetail    { requestId: string; namespace: string; }

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    /** Returns true only if `namespace` matches a UUID of an installed script. */
    async function isKnownScript(namespace: string): Promise<boolean> {
      const scripts = await scriptsItem.getValue();
      return scripts.some(s => s.id === namespace);
    }

    window.addEventListener('om-store-getall', async (e: Event) => {
      const { requestId, namespace } = (e as CustomEvent<StoreGetAllDetail>).detail;
      if (!await isKnownScript(namespace)) return;
      const store = await scriptStoreItem.getValue();
      const ns = store[namespace] ?? {};
      const data: Record<string, unknown> = {};
      for (const [k, entry] of Object.entries(ns)) data[k] = entry.value;
      window.dispatchEvent(new CustomEvent('om-store-getall-result', { detail: { requestId, data } }));
    });

    window.addEventListener('om-store-get', async (e: Event) => {
      const { requestId, namespace, key } = (e as CustomEvent<StoreGetDetail>).detail;
      if (!await isKnownScript(namespace)) return;
      const store = await scriptStoreItem.getValue();
      const value = store[namespace]?.[key]?.value;
      window.dispatchEvent(new CustomEvent('om-store-value', { detail: { requestId, value } }));
    });

    window.addEventListener('om-store-set', async (e: Event) => {
      const { requestId, namespace, key, value, secret = false } = (e as CustomEvent<StoreSetDetail>).detail;
      if (!await isKnownScript(namespace)) return;
      const store = await scriptStoreItem.getValue();
      await scriptStoreItem.setValue({
        ...store,
        [namespace]: {
          ...(store[namespace] ?? {}),
          [key]: { value, secret, updatedAt: Date.now() },
        },
      });
      window.dispatchEvent(new CustomEvent('om-store-set-ack', { detail: { requestId } }));
    });

    window.addEventListener('om-store-list', async (e: Event) => {
      const { requestId, namespace } = (e as CustomEvent<StoreListDetail>).detail;
      if (!await isKnownScript(namespace)) return;
      const store = await scriptStoreItem.getValue();
      const keys = Object.keys(store[namespace] ?? {});
      window.dispatchEvent(new CustomEvent('om-store-list-result', { detail: { requestId, keys } }));
    });

    // Atomic multi-key write — avoids race conditions when saving several keys at once.
    window.addEventListener('om-store-setmany', async (e: Event) => {
      const { requestId, namespace, patch } = (e as CustomEvent<StoreSetManyDetail>).detail;
      if (!await isKnownScript(namespace)) return;
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
      window.dispatchEvent(new CustomEvent('om-store-setmany-ack', { detail: { requestId } }));
    });

    window.addEventListener('om-store-delete', async (e: Event) => {
      const { requestId, namespace, key } = (e as CustomEvent<StoreDeleteDetail>).detail;
      if (!await isKnownScript(namespace)) return;
      const store = await scriptStoreItem.getValue();
      if (!store[namespace]) {
        window.dispatchEvent(new CustomEvent('om-store-delete-ack', { detail: { requestId } }));
        return;
      }
      const ns = { ...store[namespace] };
      delete ns[key];
      const updated = { ...store };
      if (Object.keys(ns).length === 0) {
        delete updated[namespace];
      } else {
        updated[namespace] = ns;
      }
      await scriptStoreItem.setValue(updated);
      window.dispatchEvent(new CustomEvent('om-store-delete-ack', { detail: { requestId } }));
    });
  },
});
