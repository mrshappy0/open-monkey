import { parseMeta } from '../utils/meta-parser';
import { matchesPattern } from '../utils/match-pattern';
import { scriptsItem, settingsItem } from '../utils/storage';
import { logger } from '../utils/logger';

const SKIP_SCHEMES = ['chrome://', 'chrome-extension://', 'about:', 'edge://'];

// ---------------------------------------------------------------------------
// Seed script — always present, cannot be accidentally removed on first load
// ---------------------------------------------------------------------------

const SEED_SCRIPT_ID = 'openmonkey-builtin-test-banner';

const SEED_SCRIPT_CODE = `\
// ==UserScript==
// @name         OpenMonkey - Test Banner (All Pages)
// @description  Shows a banner on every page to confirm script injection is working
// @match        *://*/*
// @run-at       document-end
// ==/UserScript==

(function () {
  function inject() {
    if (document.getElementById('__om_test_banner__')) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    const banner = document.createElement('div');
    banner.id = '__om_test_banner__';
    banner.textContent = '✅ OpenMonkey is working on this page!';
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', width: '100%',
      padding: '12px', background: '#e00', color: '#fff',
      fontSize: '18px', fontWeight: 'bold', textAlign: 'center',
      zIndex: '2147483647', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
      cursor: 'pointer',
    });
    banner.addEventListener('click', () => banner.remove());
    target.appendChild(banner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();`;

async function ensureSeedScript(): Promise<void> {
  const scripts = await scriptsItem.getValue();
  if (scripts.some(s => s.id === SEED_SCRIPT_ID)) return;
  await scriptsItem.setValue([
    {
      id: SEED_SCRIPT_ID,
      name: 'OpenMonkey - Test Banner (All Pages)',
      enabled: true,
      code: SEED_SCRIPT_CODE,
    },
    ...scripts,
  ]);
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
function getUserScriptsApi(): any | null {
  try {
    const api = (globalThis as any).chrome?.userScripts;
    if (api && typeof api.execute === 'function') return api;
  } catch {
    // Property access throws when the per-extension toggle is off.
  }
  return null;
}

export default defineBackground(() => {
  logger.log('background loaded');

  // Start the MCP bridge — connects to native-host WebSocket if it's running.
  // Silently retries every few seconds; no-op when native-host isn't active.
  connectBridge();

  // Ensure the built-in test banner script is always present in storage.
  ensureSeedScript().catch((err: unknown) => logger.warn('ensureSeedScript failed:', err));

  // Let the popup query the current bridge state on demand.
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if ((msg as { type?: string } | null)?.type === 'get_bridge_status') {
      sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    }
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
  });
});
