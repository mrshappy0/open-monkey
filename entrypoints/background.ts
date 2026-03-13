import { parseMeta } from '../utils/meta-parser';
import { matchesPattern } from '../utils/match-pattern';
import { scriptsItem } from '../utils/storage';

const SKIP_SCHEMES = ['chrome://', 'chrome-extension://', 'about:', 'edge://'];

export default defineBackground(() => {
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

    const scripts = await scriptsItem.getValue();

    for (const script of scripts) {
      if (!script.enabled) continue;

      const meta = parseMeta(script.code);
      if (!meta.matches.length) continue;

      // Treat document-idle the same as document-end (fires after DOMContentLoaded)
      const targetRunAt = meta.runAt === 'document-idle' ? 'document-end' : meta.runAt;
      if (targetRunAt !== eventRunAt) continue;

      const isMatch = meta.matches.some(p => matchesPattern(url, p));
      if (!isMatch) continue;

      const isExcluded = meta.excludes.some(p => matchesPattern(url, p));
      if (isExcluded) continue;

      try {
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
          args: [script.code],
          world: 'MAIN',
        });
      } catch (err) {
        console.error(`[OpenMonkey] Failed to inject "${script.name}":`, err);
      }
    }
  });
});
