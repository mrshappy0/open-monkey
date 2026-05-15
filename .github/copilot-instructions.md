---
applyTo: "**"
---

# GitHub Copilot Instructions — OpenMonkey

## What This Project Is

OpenMonkey is a privacy-first, open-source userscript manager built as a Chrome/Firefox extension. It is a direct replacement for Tampermonkey (closed source, data collection) and ViolentMonkey (open source but still telemetry). OpenMonkey is **never published to any browser store**, loaded unpacked from disk, and makes **zero outbound network requests**. All storage is local. All code is yours.

## Core Principles — Non-Negotiable

- **No telemetry. No analytics. No remote config. No phoning home. Ever.**
- `chrome.storage.local` by default — `chrome.storage.sync` is available as an **explicit, opt-in** user toggle only; never use it automatically or as the default. Never use IndexedDB or fetch to an external server.
- The extension is loaded unpacked. Features that only exist in the store (update_url, auto-update, review prompts) are irrelevant and should never be added
- Privacy is the product. Do not suggest features that compromise it.

---

## Stack

| Tool | Version / Notes |
|---|---|
| **Node.js** | `22+` — required. Check with `node --version`. Install via [nodejs.org](https://nodejs.org) or `nvm install 22`. |
| **pnpm** | `11+` — required. Check with `pnpm --version`. Install with `curl -fsSL https://get.pnpm.io/install.sh \| sh -`. Never use npm or yarn. |
| **Chrome** | `135+` — required for `chrome.userScripts` API. |
| **WXT** | `^0.20.x` — the extension framework. Everything goes through WXT. |
| **React** | `^19` — popup UI only |
| **TypeScript** | `^6` — strict mode, everywhere |
| **`@wxt-dev/storage`** | Typed, versioned wrapper around `chrome.storage.local` |
| **Vite** | Bundler — managed by WXT, do not configure Vite directly unless WXT exposes it |
| **`@modelcontextprotocol/sdk`** | MCP server in `native-host/` — bridges VS Code Copilot to the extension |
| **`ws`** | WebSocket library for the MCP ↔ extension bridge (port 7331) |

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

Key storage items defined in `utils/storage.ts`:

| Item | Key | Type | Purpose |
|---|---|---|---|
| `scriptsItem` | `local:scripts` | `UserScript[]` | All installed userscripts |
| `settingsItem` | `local:settings` | `Settings` | Global settings (e.g. maxRetries) |
| `scriptStoreItem` | `local:script-store` | `ScriptStore` | Per-script persistent key/value data (GM_* API) |

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
pnpm lint             # ESLint (flat config, eslint.config.js)
pnpm postinstall      # Runs `wxt prepare` — auto-run by pnpm after install
```

Always use `pnpm`. Never suggest `npm install` or `yarn add`.

**Required versions:** Node.js 22+ and pnpm 11+. If a user hits install or build errors, ask them to run `node --version` and `pnpm --version` first. Old versions are the most common root cause.

After adding or removing dependencies, remind the user to run `pnpm install` and check that `pnpm compile` passes.

## Versioning & Releases

OpenMonkey uses **semantic-release** on merge to `main`. Commit messages must follow **Conventional Commits** (`fix:`, `feat:`, `chore:`, `docs:`, etc.) — commitlint enforces this in CI.

- Every push/PR runs: commitlint → `pnpm compile` → `pnpm lint` → `pnpm build`
- Every merge to `main` also runs semantic-release: bumps `package.json` version, generates `CHANGELOG.md`, builds the zip, and publishes a GitHub Release with the zip attached
- The `[skip ci]` tag in semantic-release's version-bump commit prevents a release loop

## Updating OpenMonkey (for users and developers)

**Download users** (no build toolchain): download the latest zip from the [Releases page](https://github.com/mrshappy0/open-monkey/releases), replace the existing folder contents, click the reload icon on OpenMonkey in `chrome://extensions`.

**Developer workflow** (cloned repo): `git pull && pnpm install && pnpm build`, then click the reload icon on OpenMonkey in `chrome://extensions`. Chrome does not auto-reload unpacked extensions — the one manual reload click is always required.

---

## Userscript Metadata

OpenMonkey parses standard Greasemonkey-compatible `==UserScript==` headers. The parser lives in `utils/meta-parser.ts`. When modifying script injection logic:

- Always parse via `parseMeta()` — never inline regex against script code
- `@match` / `@exclude` use Chrome match-pattern syntax — validation is in `utils/match-pattern.ts`
- Supported `@run-at` values: `document-start`, `document-end`, `document-idle` (idle is treated as end)
- `@max-retries` is optional — falls back to `settingsItem` global default

---

## Script Injection — chrome.userScripts API

> **"Allow User Scripts" must be enabled per-extension.**
> `chrome://extensions` → OpenMonkey → **Details** → enable **"Allow User Scripts"**.
> Scripts will NOT run without this. The extension loads and the popup works, but all injection is silently skipped.

OpenMonkey injects scripts via `chrome.userScripts.execute()` (Chrome 135+) into the `USER_SCRIPT` world. This is **not** `chrome.scripting.executeScript`.

Key facts for agents:
- The `getUserScriptsApi()` helper in `background.ts` feature-detects the API. If unavailable, it logs a warning and returns early — do NOT add a fallback injection path.
- `world: 'USER_SCRIPT'` is sandboxed from both the page and the extension context.
- `userScriptsApi.configureWorld({ csp: '' })` is called on startup to allow eval/Function in injected scripts.
- The `"userScripts"` permission must be in `wxt.config.ts` manifest permissions.
- The `"alarms"` permission is also present — used for a keep-alive heartbeat that reconnects the MCP WebSocket bridge if it drops.

Do NOT suggest using `chrome.scripting.executeScript` with a script-tag injection pattern — that was the old approach and is no longer used.

---

## Script Store — GM_* API

OpenMonkey auto-injects persistent-storage helper functions into every userscript's `USER_SCRIPT` world. Scripts call them **without any import or setup** — injected as a code preamble by `buildGMPreamble()` in `background.ts`.

### Available Functions

| Function | Signature | Description |
|---|---|---|
| `GM_getValue` | `(key, default?) → Promise<unknown>` | Read a stored value; returns `default` if absent |
| `GM_setValue` | `(key, value, secret?) → Promise<void>` | Write a value; `secret: true` masks it in the popup |
| `GM_setValues` | `(patch, secretKeys?) → Promise<void>` | **Atomic** multi-key write — always prefer over looping `GM_setValue` |
| `GM_deleteValue` | `(key) → Promise<void>` | Delete a key |
| `GM_listValues` | `() → Promise<string[]>` | List all keys in this script's namespace |

### Architecture

```
USER_SCRIPT world (script code)
  → window.dispatchEvent('om-store-*' + requestId)
  → script-bridge.content.ts  (ISOLATED world content script, runs at document_start)
  → scriptStoreItem  (chrome.storage.local  →  local:script-store)
  → window.dispatchEvent('om-store-*-ack' + requestId)  ← write confirms back to USER_SCRIPT
```

- **Namespace** = the script's ID (UUID). Automatic, no configuration. **Scripts cannot read or write another script's namespace** — there is no global cross-script storage. This prevents a malicious `*://*/*` script from stealing secrets set by a trusted script.
- `om-store-set`, `om-store-setmany`, `om-store-delete` all dispatch ack events (`om-store-set-ack`, `om-store-setmany-ack`, `om-store-delete-ack`) after the storage write completes. The preamble functions await the ack, so `await GM_setValue(...)` guarantees the write is persisted before returning.
- `om-store-setmany` is the atomic multi-key event — always prefer `GM_setValues` over multiple `GM_setValue` calls to avoid read-merge-write race conditions.
- `scriptStoreItem` is defined in `utils/storage.ts` as `local:script-store` (type `ScriptStore = Record<string, Record<string, ScriptStoreEntry>>`).
- The popup **Script Data** view supports full CRUD: `+ Add to…` dropdown pre-populates any script's namespace; existing entries support inline edit (✎), delete (✕), and secret reveal (👁); script names are shown (not raw UUIDs). Deleting a script also deletes its stored namespace.

### Key Rules for Agents

- Never suggest `localStorage` for persistent script data — it's per-origin and wiped on site changes.
- Use `GM_setValues` (not `GM_setValue` in a loop) when writing multiple keys atomically.
- Mark credentials and tokens with `secret: true` / `secretKeys: ['apiKey']`.
- `GM_setValue`, `GM_setValues`, `GM_deleteValue` all return Promises that resolve after the storage write completes. `await GM_setValue(...); await GM_getValue(...)` is safe — no race condition.
- Storage is per-script namespaced. Scripts cannot access each other's data. Do NOT suggest global shared storage — it would allow any script to read secrets set by other scripts.
- Deleting a script via the popup also removes its stored namespace from `scriptStoreItem`.
- `script-bridge.content.ts` auto-registers via WXT's `.content.ts` naming convention — no manual config needed.
- Saving or editing a script in the popup sends a `script_toggled` message to the background, which reloads the active tab if the script's `@match` covers it.

---

## MCP Native Host

OpenMonkey includes a Node.js MCP server that bridges VS Code Copilot to the running Chrome extension.

### Architecture

```
VS Code Copilot → MCP stdio → native-host/index.ts → WebSocket ws://127.0.0.1:7331 → background.ts
```

### Files

| File | Purpose |
|---|---|
| `native-host/index.ts` | MCP StdioServerTransport + WebSocketServer source |
| `native-host/dist/index.js` | Compiled output — **committed to git** (not gitignored), run directly by npx |
| `tsconfig.mcp.json` | Separate TS config (NodeNext module resolution, emits to `native-host/dist/`) |

### Tools Exposed
`list_scripts`, `get_script`, `create_script`, `update_script`, `delete_script`, `get_active_tab`, `get_page_content`, `execute_script`

### Key Rules for Agents
- After editing `native-host/index.ts`, always run `pnpm prepare` to recompile. Then commit `native-host/dist/index.js`.
- `native-host/dist/` is **NOT** in `.gitignore` — the compiled file must be committed so npx can run it without a build step.
- The `send()` function polls up to 25 s for the extension WS to connect (handles service worker cold-start delay).
- Do NOT add remote fetching or telemetry to the native host.
- VS Code MCP config entry: `{ "type": "stdio", "command": "npx", "args": ["-y", "github:mrshappy0/open-monkey"] }`

---

## Security

- Scripts are injected via `chrome.userScripts.execute()` into the **USER_SCRIPT world** — Chrome's dedicated sandbox for userscripts. This requires the `"userScripts"` manifest permission AND the per-extension **"Allow User Scripts"** toggle in `chrome://extensions` → Details. Do NOT fall back to `chrome.scripting.executeScript` for userscript injection.
- The retry guard (`sessionStorage`) prevents scripts from causing infinite reloads or lockouts
- Never suggest storing credentials in `chrome.storage.sync` — sync means Google's servers. Warn users that enabling sync sends script code through Google's servers, and that plaintext credential storage (even in `local`) is only appropriate for LAN/local services not exposed to the internet
- Do not add `web_accessible_resources` entries unless strictly required — minimize extension attack surface
- `host_permissions: ['<all_urls>']` is required for cross-origin injection. Do not remove it.

---

## What NOT To Do

- **Do not suggest publishing to the Chrome Web Store or Firefox AMO** — this is against the project's philosophy
- **Do not add any analytics, crash reporting, or telemetry** — no Sentry, no PostHog, no GA, nothing
- **Do not use `chrome.storage.sync` by default** — it is allowed only as an explicit opt-in user toggle (as implemented in `background.ts`). Never enable it automatically or without user consent.
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
