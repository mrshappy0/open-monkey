import { parseMeta } from '../utils/meta-parser';
import { matchesPattern } from '../utils/match-pattern';
import { scriptsItem, settingsItem, type UserScript } from '../utils/storage';
import { logger } from '../utils/logger';
import testBannerCode from '../dev-scripts/test-banner.user.js?raw';
import askPageCode from '../dev-scripts/ask-page.user.js?raw';

const SKIP_SCHEMES = ['chrome://', 'chrome-extension://', 'about:', 'edge://'];

// ---------------------------------------------------------------------------
// Built-in scripts — seeded on first load, idempotent by fixed ID.
// devOnly: true  → only added during `pnpm dev` (import.meta.env.DEV)
// devOnly: false → added in both dev and production builds
// ---------------------------------------------------------------------------

interface BuiltinScript {
  id: string;
  name: string;
  code: string;
  devOnly: boolean;
}

const BUILTIN_SCRIPTS: BuiltinScript[] = [
  {
    id: 'openmonkey-builtin-test-banner',
    name: 'OpenMonkey - Test Banner (All Pages)',
    code: testBannerCode,
    devOnly: true,
  },
  {
    id: 'openmonkey-builtin-ask-page',
    name: 'Ask AI — Page Q&A (Ollama)',
    code: askPageCode,
    devOnly: false,
  },
];

// ---------------------------------------------------------------------------
// Chrome Sync helpers — mirror scripts to chrome.storage.sync when enabled.
// Each script is stored as its own key (om_s_{id}) to stay under Chrome's
// 8 KB per-item quota. The flag key and IDs index are always tiny.
// ---------------------------------------------------------------------------

const SYNC_FLAG_KEY = 'om_sync_enabled';
const SYNC_IDS_KEY = 'om_script_ids';

function syncScriptKey(id: string): string {
  return `om_s_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

// Chrome sync has an 8 KB per-item quota. Large scripts are split into
// 7 000-char string chunks stored as om_s_{id}_c0, _c1, … with a tiny
// marker object at om_s_{id} = { chunked: true, count: N }.
const SYNC_CHUNK_CHARS = 7000;

function chunkString(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += SYNC_CHUNK_CHARS) out.push(s.slice(i, i + SYNC_CHUNK_CHARS));
  return out;
}

async function writeSyncScripts(scripts: UserScript[]): Promise<void> {
  // Clear stale chunk keys before writing so orphaned chunks don't accumulate.
  await clearSyncScripts();
  const toSet: Record<string, unknown> = {
    [SYNC_FLAG_KEY]: true,
    [SYNC_IDS_KEY]: scripts.map(s => s.id),
  };
  for (const s of scripts) {
    const json = JSON.stringify(s);
    const base = syncScriptKey(s.id);
    if (json.length <= SYNC_CHUNK_CHARS) {
      toSet[base] = s;
    } else {
      const chunks = chunkString(json);
      toSet[base] = { chunked: true, count: chunks.length };
      chunks.forEach((c, i) => { toSet[`${base}_c${i}`] = c; });
    }
  }
  await browser.storage.sync.set(toSet);
}

async function clearSyncScripts(): Promise<void> {
  const existing = await browser.storage.sync.get(null);
  const keys = Object.keys(existing).filter(
    k => k === SYNC_FLAG_KEY || k === SYNC_IDS_KEY || k.startsWith('om_s_'),
  );
  if (keys.length > 0) await browser.storage.sync.remove(keys);
}

async function readSyncScripts(): Promise<UserScript[] | null> {
  const data = await browser.storage.sync.get(null);
  if (!data[SYNC_FLAG_KEY]) return null;
  const ids = (data[SYNC_IDS_KEY] as string[] | undefined) ?? [];
  const scripts: UserScript[] = [];
  for (const id of ids) {
    const base = syncScriptKey(id);
    const entry = data[base] as UserScript | { chunked: true; count: number } | undefined;
    if (!entry) continue;
    if ((entry as { chunked?: boolean }).chunked) {
      const { count } = entry as { chunked: true; count: number };
      const joined = Array.from({ length: count }, (_, i) => (data[`${base}_c${i}`] as string) ?? '').join('');
      try { scripts.push(JSON.parse(joined) as UserScript); }
      catch { logger.warn('[sync] failed to parse chunked script', id); }
    } else {
      scripts.push(entry as UserScript);
    }
  }
  return scripts;
}

/**
 * On startup: if another device enabled sync, pull scripts down and enable
 * locally. If already enabled locally, push current state to sync.
 */
async function initSync(): Promise<void> {
  const [settings, syncFlag] = await Promise.all([
    settingsItem.getValue(),
    browser.storage.sync.get(SYNC_FLAG_KEY),
  ]);

  if (!settings.syncEnabled && syncFlag[SYNC_FLAG_KEY]) {
    // Another device turned on sync — pull scripts and enable locally.
    const synced = await readSyncScripts();
    if (synced) {
      await settingsItem.setValue({ ...settings, syncEnabled: true });
      await scriptsItem.setValue(synced);
      logger.log('[sync] pulled', synced.length, 'scripts from Chrome sync (enabled by another device)');
    }
    return;
  }

  if (settings.syncEnabled) {
    // Already enabled — push local state to sync on restart.
    const scripts = await scriptsItem.getValue();
    await writeSyncScripts(scripts).catch((err: unknown) =>
      logger.warn('[sync] startup mirror failed:', err),
    );
  }
}

// ---------------------------------------------------------------------------

async function ensureBuiltinScripts(): Promise<void> {
  const scripts = await scriptsItem.getValue();
  const existingIds = new Set(scripts.map(s => s.id));

  const toAdd = BUILTIN_SCRIPTS
    .filter(b => !b.devOnly || import.meta.env.DEV)
    .filter(b => !existingIds.has(b.id))
    .map(b => ({ id: b.id, name: b.name, enabled: true, code: b.code }));

  if (toAdd.length === 0) return;
  await scriptsItem.setValue([...toAdd, ...scripts]);
}

// ---------------------------------------------------------------------------
// MCP bridge — WebSocket client connecting to native-host
// ---------------------------------------------------------------------------

const WS_URL = 'ws://127.0.0.1:7331';
const WS_RECONNECT_DELAY_MS = 3_000;

let ws: WebSocket | null = null;

type BridgeMessage = {
  id: string;
  type: string;
  payload?: unknown;
};

function connectBridge(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    ws = socket;
    logger.log('[bridge] connected to native host');
    browser.runtime.sendMessage({ type: 'bridge_status', connected: true }).catch(() => {});
  });

  socket.addEventListener('message', (event) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(event.data as string) as BridgeMessage;
    } catch {
      return;
    }
    handleBridgeMessage(msg).catch((err: unknown) => {
      socket.send(JSON.stringify({ id: msg.id, error: String(err) }));
    });
  });

  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    logger.log('[bridge] disconnected — will retry in', WS_RECONNECT_DELAY_MS, 'ms');
    browser.runtime.sendMessage({ type: 'bridge_status', connected: false }).catch(() => {});
    setTimeout(connectBridge, WS_RECONNECT_DELAY_MS);
  });

  socket.addEventListener('error', () => {
    // 'close' fires right after, which handles reconnect
  });
}

async function handleBridgeMessage(msg: BridgeMessage): Promise<void> {
  const reply = (result: unknown) =>
    ws?.send(JSON.stringify({ id: msg.id, result }));

  switch (msg.type) {
    case 'list_scripts': {
      const scripts = await scriptsItem.getValue();
      reply(scripts.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })));
      break;
    }

    case 'get_script': {
      const { id } = msg.payload as { id: string };
      const scripts = await scriptsItem.getValue();
      reply(scripts.find(s => s.id === id) ?? null);
      break;
    }

    case 'create_script': {
      const { code } = msg.payload as { code: string };
      const meta = parseMeta(code);
      const script = {
        id: crypto.randomUUID(),
        name: meta.name ?? 'Untitled',
        enabled: true,
        code,
      };
      const scripts = await scriptsItem.getValue();
      await scriptsItem.setValue([...scripts, script]);
      reply(script);
      break;
    }

    case 'update_script': {
      const { id, code } = msg.payload as { id: string; code: string };
      const meta = parseMeta(code);
      let updated: unknown = null;
      const scripts = await scriptsItem.getValue();
      await scriptsItem.setValue(scripts.map(s => {
        if (s.id !== id) return s;
        updated = { ...s, name: meta.name ?? s.name, code };
        return updated as typeof s;
      }));
      reply(updated);
      break;
    }

    case 'delete_script': {
      const { id } = msg.payload as { id: string };
      const scripts = await scriptsItem.getValue();
      await scriptsItem.setValue(scripts.filter(s => s.id !== id));
      reply(null);
      break;
    }

    case 'get_active_tab': {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      reply({ url: tab?.url ?? '', title: tab?.title ?? '' });
      break;
    }

    case 'get_page_content': {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) { reply(''); break; }
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText,
      });
      reply(results[0]?.result ?? '');
      break;
    }

    case 'execute_script': {
      const { code } = msg.payload as { code: string };
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) { reply(null); break; }
      // Run in ISOLATED world (extension context) — not subject to the page's CSP,
      // so eval works even on pages with strict script-src (e.g. GitHub, Google).
      // DOM, window, document, and localStorage are all accessible from isolated world.
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (c: string) => (0, eval)(c),
        args: [code],
      });
      reply(results[0]?.result ?? null);
      break;
    }

    default:
      ws?.send(JSON.stringify({ id: msg.id, error: `Unknown command: ${msg.type}` }));
  }
}

// ---------------------------------------------------------------------------
// ask-proxy — CORS-free fetch proxy for the ask-page userscript
// ---------------------------------------------------------------------------

interface AskProxyRequest {
  type: 'request';
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
}

async function streamChatProxy(
  req: AskProxyRequest,
  signal: AbortSignal,
  onToken: (content: string) => void,
): Promise<void> {
  const url = req.endpoint.replace(/\/$/, '') + '/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value, { stream: true }).split('\n')) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
      try {
        const obj = JSON.parse(t.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
        const tok = obj.choices?.[0]?.delta?.content;
        if (tok) onToken(tok);
      } catch { /* ignore malformed lines */ }
    }
  }
}

/**
 * Generates a JS preamble injected into the USER_SCRIPT world before every
 * script. Exposes GM_getValue, GM_setValue, GM_deleteValue, GM_listValues as
 * globals, namespaced to the script's ID so stores are isolated per-script.
 * Script authors never need to write window event boilerplate themselves.
 */
function buildGMPreamble(scriptId: string): string {
  const ns = JSON.stringify(scriptId);
  return `(function () {
  var _NS = ${ns};
  function GM_getValue(key, defaultValue) {
    return new Promise(function (resolve) {
      var rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      function onResult(e) {
        if (e.detail.requestId !== rid) return;
        window.removeEventListener('om-store-value', onResult);
        resolve(e.detail.value !== undefined ? e.detail.value : defaultValue);
      }
      window.addEventListener('om-store-value', onResult);
      window.dispatchEvent(new CustomEvent('om-store-get', { detail: { requestId: rid, namespace: _NS, key: key } }));
    });
  }
  // secret: true marks the value for masked display (••••••••) in the OpenMonkey
  // popup Script Data view. It does NOT encrypt the value or prevent page-level
  // JavaScript from observing it in the window event payload — the USER_SCRIPT
  // world communicates via window CustomEvents, which are visible to page scripts
  // on the same origin. Only use secret values on pages you control.
  function GM_setValue(key, value, secret) {
    return new Promise(function (resolve) {
      var rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      function onAck(e) {
        if (e.detail.requestId !== rid) return;
        window.removeEventListener('om-store-set-ack', onAck);
        resolve();
      }
      window.addEventListener('om-store-set-ack', onAck);
      window.dispatchEvent(new CustomEvent('om-store-set', {
        detail: { requestId: rid, namespace: _NS, key: key, value: value, secret: !!secret }
      }));
    });
  }
  // Atomic multi-key write — pass an object of { key: value } and an optional
  // array (or function) of keys to mark as secrets (masked in the popup, same
  // transit-visibility caveat as GM_setValue).
  function GM_setValues(patch, secretKeys) {
    return new Promise(function (resolve) {
      var rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var isSecret = typeof secretKeys === 'function'
        ? secretKeys
        : function(k) { return Array.isArray(secretKeys) && secretKeys.indexOf(k) !== -1; };
      var entries = {};
      Object.keys(patch).forEach(function(k) {
        entries[k] = { value: patch[k], secret: !!isSecret(k) };
      });
      function onAck(e) {
        if (e.detail.requestId !== rid) return;
        window.removeEventListener('om-store-setmany-ack', onAck);
        resolve();
      }
      window.addEventListener('om-store-setmany-ack', onAck);
      window.dispatchEvent(new CustomEvent('om-store-setmany', {
        detail: { requestId: rid, namespace: _NS, patch: entries }
      }));
    });
  }
  function GM_deleteValue(key) {
    return new Promise(function (resolve) {
      var rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      function onAck(e) {
        if (e.detail.requestId !== rid) return;
        window.removeEventListener('om-store-delete-ack', onAck);
        resolve();
      }
      window.addEventListener('om-store-delete-ack', onAck);
      window.dispatchEvent(new CustomEvent('om-store-delete', {
        detail: { requestId: rid, namespace: _NS, key: key }
      }));
    });
  }
  function GM_listValues() {
    return new Promise(function (resolve) {
      var rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      function onResult(e) {
        if (e.detail.requestId !== rid) return;
        window.removeEventListener('om-store-list-result', onResult);
        resolve(e.detail.keys);
      }
      window.addEventListener('om-store-list-result', onResult);
      window.dispatchEvent(new CustomEvent('om-store-list', { detail: { requestId: rid, namespace: _NS } }));
    });
  }
  globalThis.GM_getValue = GM_getValue;
  globalThis.GM_setValue = GM_setValue;
  globalThis.GM_setValues = GM_setValues;
  globalThis.GM_deleteValue = GM_deleteValue;
  globalThis.GM_listValues = GM_listValues;
})();`;
}

/**
 * Wraps a userscript's body in a sessionStorage-based retry guard so a
 * misbehaving script that triggers reloads can't lock a tab into a loop.
 * Counter is tab-scoped (sessionStorage) and clears when the tab closes.
 */
function wrapWithRetryGuard(code: string, scriptId: string, scriptName: string, maxRetries: number): string {
  const header = code.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0] ?? '';
  const body = code.slice(header.length).trim();
  const key = JSON.stringify(`openmonkey_retries_${scriptId}`);
  const name = JSON.stringify(scriptName);
  return `${header}
(function () {
  var _key = ${key};
  var _max = ${maxRetries};
  var _n = parseInt(sessionStorage.getItem(_key) || '0', 10);
  if (_n >= _max) {
    console.warn('[OpenMonkey] ' + ${name} + ': max retries (' + _max + ') reached, skipping to prevent lockout.');
    return;
  }
  sessionStorage.setItem(_key, String(_n + 1));
  ${body}
})();`;
}

/**
 * Returns chrome.userScripts if usable. Requires:
 *  - Chrome 135+ (for the one-shot .execute() method)
 *  - "userScripts" in manifest permissions
 *  - Per-extension "Allow User Scripts" toggle ON in chrome://extensions
 *    (under the extension's Details page — separate from global Dev Mode)
 */
interface UserScriptsApi {
  execute: (options: object) => Promise<void>;
  configureWorld: (options: object) => Promise<void>;
}

function getUserScriptsApi(): UserScriptsApi | null {
  try {
    const api = (globalThis as unknown as { chrome?: { userScripts?: UserScriptsApi } }).chrome?.userScripts;
    if (api && typeof api.execute === 'function') return api;
  } catch {
    // Property access throws when the per-extension toggle is off.
  }
  return null;
}

export default defineBackground(() => {
  logger.log('background loaded');

  // Keep-alive alarm — fires every 20s to prevent the service worker from
  // going inactive while the MCP bridge needs a persistent connection.
  browser.alarms.create('openmonkey-keepalive', { periodInMinutes: 1 / 3 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'openmonkey-keepalive') connectBridge();
  });

  // Start the MCP bridge — connects to native-host WebSocket if it's running.
  // Silently retries every few seconds; no-op when native-host isn't active.
  connectBridge();

  // Ensure built-in scripts are present in storage on every worker startup.
  ensureBuiltinScripts().catch((err: unknown) => logger.warn('ensureBuiltinScripts failed:', err));

  // Initialize Chrome sync — auto-pull if another device enabled it.
  initSync().catch((err: unknown) => logger.warn('initSync failed:', err));

  // Mirror script mutations to chrome.storage.sync while sync is enabled.
  scriptsItem.watch(async (scripts) => {
    const settings = await settingsItem.getValue();
    if (settings.syncEnabled && scripts) {
      writeSyncScripts(scripts).catch((err: unknown) =>
        logger.warn('[sync] mirror write failed:', err),
      );
    }
  });

  // Let the popup query the current bridge state, and handle script toggle reloads.
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const m = msg as { type?: string; id?: string } | null;
    if (m?.type === 'get_bridge_status') {
      sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
      return;
    }
    if (m?.type === 'sync_toggle') {
      const enable = (msg as { type: string; enable: boolean }).enable;
      (async () => {
        const settings = await settingsItem.getValue();
        if (enable) {
          const scripts = await scriptsItem.getValue();
          try {
            await writeSyncScripts(scripts);
            await settingsItem.setValue({ ...settings, syncEnabled: true });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        } else {
          await clearSyncScripts();
          await settingsItem.setValue({ ...settings, syncEnabled: false });
          sendResponse({ ok: true });
        }
      })();
      return true; // keep channel open for async sendResponse
    }
    if (m?.type === 'script_toggled' && m.id) {
      const scriptId = m.id;
      // Reload the active tab if the toggled script's @match covers it.
      Promise.all([
        scriptsItem.getValue(),
        browser.tabs.query({ active: true, lastFocusedWindow: true }),
      ]).then(([scripts, [tab]]) => {
        const url = tab?.url;
        if (!url || !tab?.id || SKIP_SCHEMES.some(s => url.startsWith(s))) return;
        const script = scripts.find(s => s.id === scriptId);
        if (!script) return;
        const meta = parseMeta(script.code);
        if (meta.matches.length > 0 && meta.matches.some(p => matchesPattern(url, p))) {
          logger.log(`[auto-reload] "${script.name}" toggled, reloading active tab…`);
          // Clear the retry-guard sessionStorage key for this script so the
          // reload doesn't count as a retry and hit the max-retries limit.
          const retryKey = `openmonkey_retries_${scriptId}`;
          browser.scripting.executeScript({
            target: { tabId: tab.id! },
            func: (key: string) => { sessionStorage.removeItem(key); },
            args: [retryKey],
          }).catch(() => {})
            .finally(() => {
              browser.tabs.reload(tab.id!).catch((err: unknown) =>
                logger.warn('auto-reload failed:', err),
              );
            });
        }
      }).catch(() => {});
    }
  });

  // Ask-proxy port — each connection handles one streaming API request.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ask-proxy') return;
    let abortCtrl: AbortController | null = null;
    port.onMessage.addListener((msg: AskProxyRequest | { type: 'abort' }) => {
      if (msg.type === 'request') {
        abortCtrl = new AbortController();
        streamChatProxy(msg as AskProxyRequest, abortCtrl.signal, (content) => {
          port.postMessage({ type: 'token', content });
        }).then(() => {
          port.postMessage({ type: 'done' });
        }).catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            port.postMessage({ type: 'done' });
          } else {
            port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        });
      } else if (msg.type === 'abort') {
        abortCtrl?.abort();
      }
    });
    port.onDisconnect.addListener(() => {
      abortCtrl?.abort();
    });
  });

  const userScriptsApi = getUserScriptsApi();
  if (!userScriptsApi) {
    logger.warn(
      'chrome.userScripts API unavailable. Open chrome://extensions, click ' +
      'this extension\'s Details, and enable "Allow User Scripts".'
    );
    return;
  }

  // Disable CSP for the USER_SCRIPT world so eval/Function work in injected
  // userscripts (matches Tampermonkey's sandbox semantics).
  try {
    userScriptsApi.configureWorld({ csp: '' });
  } catch (err) {
    logger.warn('configureWorld failed:', err);
  }

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
      const url = tab.url;
      if (!url || SKIP_SCHEMES.some(s => url.startsWith(s))) return;

      const eventRunAt =
        changeInfo.status === 'loading' ? 'document-start'
        : changeInfo.status === 'complete' ? 'document-end'
        : null;
      if (!eventRunAt) return;

      const [scripts, settings] = await Promise.all([
        scriptsItem.getValue(),
        settingsItem.getValue(),
      ]);

      for (const script of scripts) {
        if (!script.enabled) continue;

        const meta = parseMeta(script.code);
        if (!meta.matches.length) continue;

        // document-idle is treated like document-end (after DOMContentLoaded).
        const targetRunAt = meta.runAt === 'document-idle' ? 'document-end' : meta.runAt;
        if (targetRunAt !== eventRunAt) continue;

        if (!meta.matches.some(p => matchesPattern(url, p))) continue;
        if (meta.excludes.some(p => matchesPattern(url, p))) continue;

        const maxRetries = meta.maxRetries ?? settings.maxRetries;
        const preamble = buildGMPreamble(script.id);
        const code = wrapWithRetryGuard(script.code, script.id, script.name, maxRetries);

        try {
          await userScriptsApi.execute({
            target: { tabId },
            js: [{ code: preamble }, { code }],
            world: 'USER_SCRIPT',
          });
          logger.log(`injected "${script.name}" → ${url}`);
        } catch (err) {
          logger.error(`failed to inject "${script.name}":`, err);
        }
      }
    } catch (err) {
      logger.warn('tabs.onUpdated handler error:', err);
    }
  });
});
