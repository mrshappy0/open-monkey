// ==UserScript==
// @name         OpenMonkey - Test Banner (All Pages)
// @description  Shows a banner on every page to confirm script injection is working
// @match        *://*/*
// @run-at       document-end
// ==/UserScript==

(function () {
  function inject() {
    if (document.getElementById('__om_test_banner__')) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    const banner = document.createElement('div');
    banner.id = '__om_test_banner__';
    banner.textContent = '✅ OpenMonkey is working on this page!';
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', width: '100%',
      padding: '12px', background: '#e00', color: '#fff',
      fontSize: '18px', fontWeight: 'bold', textAlign: 'center',
      zIndex: '2147483647', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
      cursor: 'pointer',
    });
    banner.addEventListener('click', () => banner.remove());
    target.appendChild(banner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
