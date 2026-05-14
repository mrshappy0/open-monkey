const PREFIX = '[OpenMonkey]';

/**
 * Dev-only logger. All calls are compile-time eliminated in production builds
 * because Vite replaces `import.meta.env.DEV` with `false` and tree-shakes
 * the dead branches out of the bundle.
 */
export const logger = {
  log:   (...args: unknown[]) => { if (import.meta.env.DEV) console.log(PREFIX,   ...args); },
  warn:  (...args: unknown[]) => { if (import.meta.env.DEV) console.warn(PREFIX,  ...args); },
  // console.error in a service worker triggers Chrome's extension error badge.
  // Use console.warn in prod so failures are still logged without alarming the user.
  error: (...args: unknown[]) => { if (import.meta.env.DEV) console.error(PREFIX, ...args); else console.warn(PREFIX, ...args); },
};
