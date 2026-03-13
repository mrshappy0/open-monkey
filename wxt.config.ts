import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'OpenMonkey',
    description: 'Lightweight, privacy-respecting userscript manager. Self-hosted, never published to the store.',
    permissions: ['scripting', 'storage', 'tabs'],
    host_permissions: ['<all_urls>'],
  },
});
