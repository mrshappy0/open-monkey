/**
 * Tests whether a URL matches a Chrome extension match pattern.
 * Handles: <all_urls>, scheme wildcards, host wildcards, path wildcards.
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */
export function matchesPattern(url: string, pattern: string): boolean {
  if (!url || !pattern) return false;
  if (pattern === '<all_urls>') return true;

  try {
    const urlObj = new URL(url);

    // Pattern format: <scheme>://<host><path>
    const m = pattern.match(/^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/]*)(\/.*)$/);
    if (!m) return false;

    const [, scheme, host, path] = m;

    // Scheme check
    if (scheme !== '*') {
      if (urlObj.protocol !== `${scheme}:`) return false;
    } else {
      if (!['http:', 'https:'].includes(urlObj.protocol)) return false;
    }

    // Host check
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const escaped = escapeRegex(host.slice(2));
        if (!new RegExp(`^(.+\\.)?${escaped}$`).test(urlObj.hostname)) return false;
      } else {
        if (urlObj.hostname !== host) return false;
      }
    }

    // Path check (pathname + search)
    const actual = urlObj.pathname + (urlObj.search || '');
    const pathRegex = new RegExp(`^${path.split('*').map(escapeRegex).join('.*')}$`);
    if (!pathRegex.test(actual)) return false;

    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
