// ==UserScript==
// @name         Reading Mode — Distraction-Free Reader
// @match        *://*/*
// @run-at       document-end
// @version      1.5.0
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('om-reader-fab')) return;

  // FAB button
  const fab = document.createElement('button');
  fab.id = 'om-reader-fab';
  fab.textContent = '📖';
  fab.title = 'Toggle Reading Mode (Ctrl+Shift+.)';
  Object.assign(fab.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '2147483646',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    border: 'none',
    background: '#1a1a2e',
    color: '#fff',
    fontSize: '22px',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: '1',
  });
  document.body.appendChild(fab);

  function extractContent() {
    var candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.getElementById('mw-content-text'),
      document.body,
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) return candidates[i];
    }
    return document.body;
  }

  function openReader() {
    if (document.getElementById('om-reader-overlay')) return;

    var source = extractContent();
    var clone = source.cloneNode(true);

    // Strip noise from clone
    ['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe',
      '.ad', '[class*="sidebar"]', '[class*="banner"]', '[id*="sidebar"]',
    ].forEach(function (sel) {
      try {
        clone.querySelectorAll(sel).forEach(function (el) { el.remove(); });
      } catch (e) {}
    });

    var overlay = document.createElement('div');
    overlay.id = 'om-reader-overlay';
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      overflowY: 'auto',
      background: prefersDark ? '#1a1a1a' : '#f9f6f0',
      color: prefersDark ? '#e0d9ce' : '#222',
      padding: '0',
    });

    var inner = document.createElement('div');
    Object.assign(inner.style, {
      maxWidth: '720px',
      margin: '0 auto',
      padding: '48px 24px 80px',
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '20px',
      lineHeight: '1.8',
    });

    var exitBtn = document.createElement('button');
    exitBtn.textContent = '✕ Exit Reader';
    Object.assign(exitBtn.style, {
      display: 'block',
      marginBottom: '32px',
      background: 'transparent',
      border: '1px solid currentColor',
      color: 'inherit',
      padding: '6px 14px',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '14px',
      fontFamily: 'sans-serif',
    });
    exitBtn.addEventListener('click', closeReader);

    inner.appendChild(exitBtn);
    inner.appendChild(clone);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);
    fab.textContent = '✕';
  }

  function closeReader() {
    var overlay = document.getElementById('om-reader-overlay');
    if (overlay) overlay.remove();
    fab.textContent = '📖';
  }

  function toggleReader() {
    if (document.getElementById('om-reader-overlay')) {
      closeReader();
    } else {
      openReader();
    }
  }

  fab.addEventListener('click', toggleReader);

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === '.') {
      e.preventDefault();
      toggleReader();
    }
  });
})();
