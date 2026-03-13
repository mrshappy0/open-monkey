import { parseMeta } from '../utils/meta-parser';
import { matchesPattern } from '../utils/match-pattern';
import { scriptsItem, settingsItem } from '../utils/storage';
import { logger } from '../utils/logger';

/**
 * Wraps a userscript's body in a sessionStorage-based retry guard.
 * The counter is tab-scoped (sessionStorage) and resets when the tab closes.
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
})();`
}

const SKIP_SCHEMES = ['chrome://', 'chrome-extension://', 'about:', 'edge://'];

export default defineBackground(() => {
  logger.log('background loaded');

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const url = tab.url;
    if (!url || SKIP_SCHEMES.some(s => url.startsWith(s))) return;

    // Map browser navigation events to @run-at values
    const eventRunAt =
      changeInfo.status === 'loading'
        ? 'document-start'
        : changeInfo.status === 'complete'
          ? 'document-end'
          : null;
    if (!eventRunAt) return;

    logger.log(`tab updated — ${eventRunAt} — ${url}`);

    const [scripts, settings] = await Promise.all([
      scriptsItem.getValue(),
      settingsItem.getValue(),
    ]);
    logger.log(`${scripts.length} script(s) in storage`);

    for (const script of scripts) {
      if (!script.enabled) {
        logger.log(`skip "${script.name}" (disabled)`);
        continue;
      }

      const meta = parseMeta(script.code);
      if (!meta.matches.length) {
        logger.log(`skip "${script.name}" (no @match patterns)`);
        continue;
      }

      // Treat document-idle the same as document-end (fires after DOMContentLoaded)
      const targetRunAt = meta.runAt === 'document-idle' ? 'document-end' : meta.runAt;
      if (targetRunAt !== eventRunAt) {
        logger.log(`skip "${script.name}" (run-at mismatch: want ${targetRunAt}, got ${eventRunAt})`);
        continue;
      }

      const isMatch = meta.matches.some(p => {
        const result = matchesPattern(url, p);
        logger.log(`"${script.name}" pattern "${p}" vs "${url}" → ${result}`);
        return result;
      });
      if (!isMatch) continue;

      const isExcluded = meta.excludes.some(p => matchesPattern(url, p));
      if (isExcluded) {
        logger.log(`skip "${script.name}" (excluded)`);
        continue;
      }

      logger.log(`injecting "${script.name}"`);
      try {
        const maxRetries = meta.maxRetries ?? settings.maxRetries;
        const codeToInject = maxRetries > 0
          ? wrapWithRetryGuard(script.code, script.id, script.name, maxRetries)
          : script.code;

        // Inject via script tag into the page's MAIN world.
        // This avoids extension CSP constraints while giving full DOM access.
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (code: string) => {
            const el = Object.assign(document.createElement('script'), {
              textContent: code,
            });
            document.documentElement.appendChild(el);
            el.remove();
          },
          args: [codeToInject],
          world: 'MAIN',
        });
        logger.log(`injected "${script.name}" OK`);
      } catch (err) {
        logger.error(`Failed to inject "${script.name}":`, err);
      }
    }
  });
});
