const PREFIX = '[OpenMonkey]';

/**
 * Dev-only logger. All calls are compile-time eliminated in production builds
 * because Vite replaces `import.meta.env.DEV` with `false` and tree-shakes
 * the dead branches out of the bundle.
 */
export const logger = {
  log:   (...args: unknown[]) => { if (import.meta.env.DEV) console.log(PREFIX,   ...args); },
  warn:  (...args: unknown[]) => { if (import.meta.env.DEV) console.warn(PREFIX,  ...args); },
  error: (...args: unknown[]) => {                           console.error(PREFIX, ...args); },
  //     ^ errors always surface, even in prod — silent failures are worse
};
