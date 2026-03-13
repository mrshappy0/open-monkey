# OpenMonkey — Custom Userscript Manager Chrome Extension

> **Context:** Spawned from a conversation about auto-logging into a local Unraid server (`http://unraid.shaplabs/Dashboard`). The goal expanded into building a lightweight, privacy-respecting, open-source alternative to Tampermonkey/ViolentMonkey.

---

## Why build this?

- Tampermonkey is closed source and collects data
- ViolentMonkey is open source but also collects data
- A custom Chrome extension (loaded unpacked from disk) has zero third-party involvement
- Fully self-owned, version-controllable, and extensible to any future automation needs

---

## Architecture

**Type:** Chrome Extension, Manifest V3  
**Storage:** `chrome.storage.local` (fully local, no sync, no server)  
**Injection method:** `chrome.scripting.executeScript` with `world: "MAIN"` so scripts run in the page's own JS context (same DOM access as Tampermonkey)

### File structure

```
openmonkey/
├── manifest.json       # MV3 manifest, permissions, background registration
├── background.js       # Service worker: listens for navigation, injects matching scripts
├── popup.html          # Extension popup UI (add/edit/delete/toggle scripts)
├── popup.js            # Popup logic, reads/writes chrome.storage.local
└── icon.png            # Optional 128x128 icon
```

---

## Implementation Plan

### v1 — Fully functional core (target: weekend build)

**manifest.json**
- `manifest_version: 3`
- `background.service_worker: "background.js"`
- `action` pointing to popup.html
- `permissions: ["scripting", "storage", "tabs"]`
- `host_permissions: ["<all_urls>"]` ← required for cross-origin injection

**background.js**
- Listen on `chrome.tabs.onUpdated` (filter: `status === "complete"`)
- Load all scripts from `chrome.storage.local`
- For each script, parse `@match` from its header block using regex
- If the tab URL matches, call `chrome.scripting.executeScript` with `world: "MAIN"`

```js
// Core injection pattern
chrome.scripting.executeScript({
  target: { tabId },
  func: (code) => { eval(code); },
  args: [userScriptCode],
  world: "MAIN"
});
```

**Script metadata format** — userscripts use a familiar header block:
```js
// ==UserScript==
// @name     Unraid Auto Login
// @match    http://unraid.shaplabs/*
// @run-at   document-end
// ==/UserScript==

// ... script body below
```

**Metadata parser** — simple regex:
```js
function parseMeta(code) {
  const block = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/)?.[1] ?? '';
  const get = (key) => [...block.matchAll(new RegExp(`@${key}\\s+(.+)`, 'g'))].map(m => m[1].trim());
  return { name: get('name')[0], matches: get('match'), runAt: get('run-at')[0] ?? 'document-end' };
}
```

**Storage schema:**
```js
// chrome.storage.local key: "scripts"
// Value: array of:
{
  id: "uuid-or-timestamp",
  name: "Unraid Auto Login",
  enabled: true,
  code: "// ==UserScript==\n// @name ...\n..."
}
```

**popup.html / popup.js**
- List all stored scripts with enable/disable toggle
- "New Script" button → textarea pre-filled with header template
- Edit / Delete per script
- Save writes back to `chrome.storage.local`

---

### v2 — Quality of life

- `@exclude` pattern support
- `@run-at document-start` (use `chrome.tabs.onUpdated` with `status === "loading"`)
- Script execution ordering
- Import/export scripts as `.js` files

### v3 — Polish

- CodeMirror (lightweight build) for syntax highlighting in the editor
- `@require` to load external libraries (fetched once, cached in storage)
- Per-script execution log / error display in popup

---

## First Script: Unraid Auto Login

The immediate use case that kicked this off. Once the extension is working, add this script:

```js
// ==UserScript==
// @name     Unraid Auto Login
// @match    http://unraid.shaplabs/*
// @run-at   document-end
// ==/UserScript==

(function () {
  // Inspect actual Unraid login form to confirm field selectors
  const user = document.querySelector('input[name="username"], #username');
  const pass = document.querySelector('input[name="password"], #password');
  const form = document.querySelector('form');

  if (user && pass && form) {
    user.value = 'YOUR_USERNAME';
    pass.value = 'YOUR_PASSWORD';
    form.submit();
  }
})();
```

> **Note:** Right-click → Inspect on the Unraid login form to confirm the exact `name` or `id` attributes for the username and password fields before finalizing the selectors.

**After login redirect fix:** Set your Chrome startup tab to `http://unraid.shaplabs/Dashboard`. The script fires on the login page, submits the form, and Unraid lands you on Dashboard.

---

## Key MV3 Gotcha

Manifest V3 service workers don't persist between events. `chrome.storage.local` is fine (it persists), but don't rely on in-memory variables in `background.js` surviving between tab navigations. Always read from storage fresh on each event.

---

## Security note

Credentials are stored in `chrome.storage.local` in plaintext. This is acceptable for a local LAN hostname not exposed to the internet. Do not store credentials for public-facing services this way.

---

## Suggested repo structure for new project

```
openmonkey/
├── AGENTS.md           # This file (renamed), Copilot context
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── icon.png
└── scripts/            # Optional: store your userscripts as .js files for version control
    └── unraid-login.js
```
