import { parseMeta } from '../utils/meta-parser';
import { matchesPattern } from '../utils/match-pattern';
import { scriptsItem, settingsItem } from '../utils/storage';
import { logger } from '../utils/logger';
import testBannerCode from '../dev-scripts/test-banner.user.js?raw';
import readingModeCode from '../dev-scripts/reading-mode.user.js?raw';
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
    id: 'openmonkey-builtin-reading-mode',
    name: 'Reading Mode — Distraction-Free Reader',
    code: readingModeCode,
    devOnly: false,
  },
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
      // Run in MAIN world so the code has full page-context access.
      // Code is passed as a serialized arg — no eval happens in the service worker.
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
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

  // Let the popup query the current bridge state, and handle script toggle reloads.
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const m = msg as { type?: string; id?: string } | null;
    if (m?.type === 'get_bridge_status') {
      sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
      return;
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
        const code = wrapWithRetryGuard(script.code, script.id, script.name, maxRetries);

        try {
          await userScriptsApi.execute({
            target: { tabId },
            js: [{ code }],
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
