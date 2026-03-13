---
applyTo: "**"
---

# GitHub Copilot Instructions — OpenMonkey

## What This Project Is

OpenMonkey is a privacy-first, open-source userscript manager built as a Chrome/Firefox extension. It is a direct replacement for Tampermonkey (closed source, data collection) and ViolentMonkey (open source but still telemetry). OpenMonkey is **never published to any browser store**, loaded unpacked from disk, and makes **zero outbound network requests**. All storage is local. All code is yours.

## Core Principles — Non-Negotiable

- **No telemetry. No analytics. No remote config. No phoning home. Ever.**
- `chrome.storage.local` only — never `chrome.storage.sync`, never IndexedDB, never fetch to an external server
- The extension is loaded unpacked. Features that only exist in the store (update_url, auto-update, review prompts) are irrelevant and should never be added
- Privacy is the product. Do not suggest features that compromise it.

---

## Stack

| Tool | Version / Notes |
|---|---|
| **WXT** | `^0.20.x` — the extension framework. Everything goes through WXT. |
| **React** | `^19` — popup UI only |
| **TypeScript** | Strict mode, everywhere |
| **pnpm** | Package manager. Never use npm or yarn. |
| **`@wxt-dev/storage`** | Typed, versioned wrapper around `chrome.storage.local` |
| **Vite** | Bundler — managed by WXT, do not configure Vite directly unless WXT exposes it |

---

## WXT Conventions — Follow These Religiously

### Entrypoints

All extension entry points live in `entrypoints/`. WXT discovers and builds them automatically based on file naming.

**Naming rules:**
- `entrypoints/background.ts` → MV3 service worker
- `entrypoints/popup/index.html` + siblings → popup (use directory form, not `popup.html`)
- `entrypoints/{name}.content.ts` → content script named `{name}`
- `entrypoints/{name}.html` → unlisted page

**Critical rules:**
- NEVER place runtime code outside the entrypoint's main function. WXT imports the file in a Node environment during build.
- ALWAYS use `defineBackground()`, `defineContentScript()`, `defineUnlistedScript()` wrappers

```ts
// ✅ Correct
export default defineBackground(() => {
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // ...
  });
});

// ❌ Wrong — crashes the build
browser.tabs.onUpdated.addListener(() => {});
export default defineBackground(() => {});
```

- DO NOT put files related to an entrypoint directly in `entrypoints/`. Use a directory:

```
✅ entrypoints/popup/index.html
✅ entrypoints/popup/App.tsx
✅ entrypoints/popup/style.css

❌ entrypoints/popup.html
❌ entrypoints/popup.ts   ← WXT treats this as a second entrypoint
```

- Entrypoints must be zero or one level deep — deeply nested entrypoints are not supported

### Extension APIs

- Use the `browser` variable from WXT — it's a unified polyfill over `chrome` and `browser` globals
- With auto-imports enabled, you do NOT need to import `browser` — it's globally available in entrypoints
- NEVER use `chrome.*` directly when there is a `browser.*` equivalent — stay cross-browser
- Use feature detection for optional APIs:

```ts
// ✅
browser.runtime.onSuspend?.addListener(() => {});

// ❌ — throws if API is absent
browser.runtime.onSuspend.addListener(() => {});
```

- Do NOT use `browser.*` outside of entrypoint main functions — it won't exist at build time

### Storage (via `@wxt-dev/storage`)

Always define storage items using `storage.defineItem()` in `utils/storage.ts`. Never call `chrome.storage` directly.

```ts
// ✅ Correct — typed, versioned, with fallback
export const scriptsItem = storage.defineItem<UserScript[]>('local:scripts', {
  fallback: [],
  version: 1,
});

// ❌ Wrong — raw chrome API, no type safety, no versioning
chrome.storage.local.get('scripts', (data) => {});
```

Storage items use the `local:` prefix for `chrome.storage.local`. Never use `sync:` — OpenMonkey is local-only by design.

Use `.watch()` for reactive updates in React (already wired in the popup):

```ts
const unwatch = scriptsItem.watch(val => setScripts(val ?? []));
// Clean up in useEffect return
return unwatch;
```

### Project Structure — Auto-Imports

WXT auto-imports from these directories — no import statements needed in most files:
- `utils/` — generic utilities (storage, parsers, helpers)
- `components/` — UI components (if added)
- `hooks/` — React hooks (if added)

Do NOT add explicit imports for things that come from these directories in entrypoint files unless you're referencing them from outside an entrypoint.

### wxt.config.ts

Manifest options go in `wxt.config.ts`, not in a `manifest.json` file. WXT generates the manifest at build time.

```ts
// ✅
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'OpenMonkey',
    permissions: ['scripting', 'storage', 'tabs'],
    host_permissions: ['<all_urls>'],
  },
});
```

Cross-browser include/exclude for entrypoints go inside the entrypoint file itself, not in the config.

---

## TypeScript Standards

- **Strict mode is always on.** No `any` unless you have a compelling, documented reason.
- Prefer `interface` for object shapes, `type` for unions/intersections
- Use `as const` for readonly tuples and enum-like patterns
- Never use `!` non-null assertions — use optional chaining or explicit guards
- Export types alongside the values that use them

```ts
// ✅
export interface UserScript {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
}

// ❌ — avoid any
function parseMeta(code: any): any {}
```

---

## React Standards (Popup UI)

- **Functional components only.** No class components.
- State: prefer `useState` + `useEffect` for simple cases. Don't reach for external state management unless complexity clearly demands it.
- Co-locate component-specific styles with the component (`.css` file in the same directory)
- Keep components in `entrypoints/popup/` for popup-specific UI. If a component becomes reused, move to `components/`
- Use `crypto.randomUUID()` for generating script IDs — no external uuid library needed
- Avoid unnecessary re-renders: memoize callbacks with `useCallback` only when passing to children that are wrapped in `React.memo`

```tsx
// ✅ — clean component pattern used in this project
export default function App() {
  const [scripts, setScripts] = useState<UserScript[]>([]);

  useEffect(() => {
    scriptsItem.getValue().then(setScripts);
    const unwatch = scriptsItem.watch(val => setScripts(val ?? []));
    return unwatch;
  }, []);

  // ...
}
```

---

## File Naming

| Pattern | Convention |
|---|---|
| React components | `PascalCase.tsx` |
| Utilities | `kebab-case.ts` |
| Entrypoint directories | `lowercase` (WXT requirement) |
| CSS files | Same name as component or `style.css` / `App.css` |

---

## Commands

```bash
pnpm dev              # Dev mode with hot-reload (Chrome)
pnpm dev:firefox      # Dev mode (Firefox)
pnpm build            # Production build → .output/chrome-mv3/
pnpm build:firefox    # Production build → .output/firefox-mv3/
pnpm zip              # Zip for sideloading/sharing
pnpm compile          # Type-check only (no emit)
pnpm postinstall      # Runs `wxt prepare` — auto-run by pnpm after install
```

Always use `pnpm`. Never suggest `npm install` or `yarn add`.

After adding or removing dependencies, remind the user to run `pnpm install` and check that `pnpm compile` passes.

---

## Userscript Metadata

OpenMonkey parses standard Greasemonkey-compatible `==UserScript==` headers. The parser lives in `utils/meta-parser.ts`. When modifying script injection logic:

- Always parse via `parseMeta()` — never inline regex against script code
- `@match` / `@exclude` use Chrome match-pattern syntax — validation is in `utils/match-pattern.ts`
- Supported `@run-at` values: `document-start`, `document-end`, `document-idle` (idle is treated as end)
- `@max-retries` is optional — falls back to `settingsItem` global default

---

## Security

- Scripts are injected into the page's **MAIN world** via `chrome.scripting.executeScript` with a dynamically created `<script>` tag. This is intentional — it gives userscripts the same DOM access as Tampermonkey.
- The retry guard (`sessionStorage`) prevents scripts from causing infinite reloads or lockouts
- Never suggest storing credentials in `chrome.storage.sync` — sync means Google's servers. `chrome.storage.local` only, and warn users that plaintext credential storage is only appropriate for LAN/local services not exposed to the internet
- Do not add `web_accessible_resources` entries unless strictly required — minimize extension attack surface
- `host_permissions: ['<all_urls>']` is required for cross-origin injection. Do not remove it.

---

## What NOT To Do

- **Do not suggest publishing to the Chrome Web Store or Firefox AMO** — this is against the project's philosophy
- **Do not add any analytics, crash reporting, or telemetry** — no Sentry, no PostHog, no GA, nothing
- **Do not use `chrome.storage.sync`** — ever
- **Do not add auto-update mechanisms** — the user manages updates via git
- **Do not add remote `@require` fetching without caching** — if added, scripts must be cached locally in storage
- **Do not use `npm` or `yarn`** — pnpm only
- **Do not add a `manifest.json` file** — WXT generates it from `wxt.config.ts`
- **Do not place runtime extension API calls outside entrypoint main functions**
- **Do not add unnecessary abstractions or boilerplate** — keep it lean

---

## Adding New Features — Checklist

1. Does the feature require a new entrypoint? → Create it in `entrypoints/` following WXT naming rules
2. Does it need persistent state? → Define a typed `storage.defineItem()` in `utils/storage.ts`
3. Does it involve URL matching? → Use `matchesPattern()` from `utils/match-pattern.ts`
4. Does it parse script headers? → Use `parseMeta()` from `utils/meta-parser.ts`
5. Does it make a network request? → **Stop. OpenMonkey doesn't do that.**
6. Run `pnpm compile` after any structural change to catch type errors early

---

## References

- [WXT Docs](https://wxt.dev/guide/essentials/project-structure.html)
- [WXT Entrypoints](https://wxt.dev/guide/essentials/entrypoints.html)
- [WXT Storage](https://wxt.dev/guide/essentials/storage.html)
- [WXT Extension APIs](https://wxt.dev/guide/essentials/extension-apis.html)
- [Chrome Match Patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- [MV3 Service Workers](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)
