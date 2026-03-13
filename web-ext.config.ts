import { defineWebExtConfig } from 'wxt';

// Only used by `pnpm dev` (the web-ext browser runner).
// Has zero effect on `pnpm build` / production.
//
// --user-data-dir persists the Chrome profile across dev restarts so:
//   • Extension storage (scripts) survives reloads
//   • Google/other sites see a real session (no bot prompts)
//   • Developer mode toggle and pinned extension stay set after first run
export default defineWebExtConfig({
  chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
  startUrls: ['google.com'],
});
