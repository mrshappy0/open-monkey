// ==UserScript==
// @name         Ask AI — Page Q&A (Ollama)
// @description  Floating button on every page — type a question and get an AI answer using the full page content as context, powered by a local Ollama model.
// @match        *://*/*
// @run-at       document-end
// @version      1.0.0
// ==/UserScript==

(function () {
  'use strict';

  const OLLAMA_BASE = 'http://localhost:11434';
  const HOST_ID = 'om-ask-host';
  const MAX_PAGE_CHARS = 8000;

  if (document.getElementById(HOST_ID)) return;

  // ── Page text extraction ────────────────────────────────────────────────

  function extractPageText() {
    const el =
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('main') ||
      document.getElementById('mw-content-text') ||
      document.body;
    if (!el) return '';
    return (el.innerText || '').replace(/\s{3,}/g, '\n\n').trim().slice(0, MAX_PAGE_CHARS);
  }

  // ── Ollama helpers ──────────────────────────────────────────────────────

  async function fetchModels() {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const { models = [] } = await res.json();
      return models.map(m => m.name);
    } catch {
      return [];
    }
  }

  async function streamGenerate(model, prompt, signal, onToken) {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: true }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) onToken(obj.response);
        } catch { /* ignore malformed lines */ }
      }
    }
  }

  // ── Shadow DOM host ─────────────────────────────────────────────────────

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  // ── Styles ──────────────────────────────────────────────────────────────

  const css = document.createElement('style');
  css.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    button { cursor: pointer; }

    #fab {
      position: fixed; bottom: 24px; left: 24px; z-index: 2147483646;
      width: 48px; height: 48px; border-radius: 50%; border: none;
      background: #1a1a2e; color: #fff; font-size: 22px;
      box-shadow: 0 4px 12px rgba(0,0,0,.45);
      display: flex; align-items: center; justify-content: center; line-height: 1;
      transition: background .15s, transform .1s;
    }
    #fab:hover { background: #16213e; transform: scale(1.06); }
    #fab:active { transform: scale(.94); }

    #panel {
      position: fixed; bottom: 82px; left: 24px; z-index: 2147483646;
      width: 380px; max-height: 520px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.65);
      display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; color: #e6edf3;
      opacity: 0; transform: translateY(10px) scale(.97);
      pointer-events: none;
      transition: opacity .15s, transform .15s;
    }
    #panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: all; }

    #header {
      padding: 10px 14px; border-bottom: 1px solid #21262d;
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    #header-title { flex: 1; font-weight: 600; font-size: 13px; }
    #model-select {
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      color: #8b949e; font-size: 11px; padding: 3px 6px; cursor: pointer;
      max-width: 140px;
    }
    #model-select option { background: #0d1117; }

    #messages {
      flex: 1; overflow-y: auto; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 14px; min-height: 80px;
    }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }

    .msg-wrap { display: flex; flex-direction: column; gap: 3px; }
    .msg-label { font-size: 11px; font-weight: 600; }
    .msg-label.user { color: #58a6ff; }
    .msg-label.ai   { color: #7ee787; }
    .msg-text { line-height: 1.55; white-space: pre-wrap; }
    .msg-text.user  { color: #cdd9e5; }
    .msg-text.ai    { color: #e6edf3; }
    .msg-text.error { color: #f85149; }
    .msg-text.hint  { color: #8b949e; font-size: 13px; }

    .cursor {
      display: inline-block; width: 7px; height: 13px; background: #58a6ff;
      vertical-align: text-bottom; animation: blink .7s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0 } }

    #input-row {
      padding: 10px 14px; border-top: 1px solid #21262d;
      display: flex; gap: 8px; flex-shrink: 0; align-items: flex-end;
    }
    #q {
      flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 8px 10px; color: #e6edf3; font-family: inherit; font-size: 13px;
      resize: none; line-height: 1.4; outline: none; overflow-y: hidden;
      min-height: 36px; max-height: 96px;
    }
    #q:focus { border-color: #58a6ff; }
    #q::placeholder { color: #484f58; }
    #send {
      background: #238636; border: none; border-radius: 8px; color: #fff;
      font-size: 18px; width: 36px; height: 36px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s;
    }
    #send:hover { background: #2ea043; }
    #send:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  `;
  shadow.appendChild(css);

  // ── FAB ─────────────────────────────────────────────────────────────────

  const fab = document.createElement('button');
  fab.id = 'fab';
  fab.textContent = '🤖';
  fab.title = 'Ask AI about this page';
  shadow.appendChild(fab);

  // ── Panel ────────────────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id = 'panel';

  // Header
  const header = document.createElement('div');
  header.id = 'header';
  const headerTitle = document.createElement('span');
  headerTitle.id = 'header-title';
  headerTitle.textContent = '🤖 Ask about this page';
  header.appendChild(headerTitle);
  const modelSelect = document.createElement('select');
  modelSelect.id = 'model-select';
  modelSelect.innerHTML = '<option value="">Loading…</option>';
  header.appendChild(modelSelect);
  panel.appendChild(header);

  // Messages
  const messages = document.createElement('div');
  messages.id = 'messages';
  const hintEl = makeMsg('hint', null, 'Ask anything about this page — the full content is included as context. Requires Ollama running locally (ollama serve).');
  messages.appendChild(hintEl[0]);
  panel.appendChild(messages);

  // Input row
  const inputRow = document.createElement('div');
  inputRow.id = 'input-row';
  const qInput = document.createElement('textarea');
  qInput.id = 'q';
  qInput.placeholder = 'What is this page about?';
  qInput.rows = 1;
  inputRow.appendChild(qInput);
  const sendBtn = document.createElement('button');
  sendBtn.id = 'send';
  sendBtn.title = 'Ask (Enter)';
  sendBtn.textContent = '↑';
  inputRow.appendChild(sendBtn);
  panel.appendChild(inputRow);

  shadow.appendChild(panel);

  // ── Load models ──────────────────────────────────────────────────────────

  fetchModels().then(models => {
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">Ollama not found</option>';
      return;
    }
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    const prefs = ['llama3', 'llama3.1', 'llama3.2', 'mistral', 'gemma2', 'phi3', 'phi4', 'deepseek'];
    const best = models.find(m => prefs.some(p => m.startsWith(p)));
    if (best) modelSelect.value = best;
  });

  // ── Toggle ───────────────────────────────────────────────────────────────

  let panelOpen = false;
  fab.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) setTimeout(() => qInput.focus(), 160);
  });

  // ── Auto-resize textarea ─────────────────────────────────────────────────

  qInput.addEventListener('input', () => {
    qInput.style.height = 'auto';
    qInput.style.height = Math.min(qInput.scrollHeight, 96) + 'px';
    qInput.style.overflowY = qInput.scrollHeight > 96 ? 'auto' : 'hidden';
  });

  // ── Send ─────────────────────────────────────────────────────────────────

  qInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) ask();
    }
  });
  sendBtn.addEventListener('click', ask);

  let abortCtrl = null;

  async function ask() {
    const question = qInput.value.trim();
    if (!question) return;

    const model = modelSelect.value;
    if (!model) {
      const [el] = makeMsg('error', null, 'No model selected. Is Ollama running? Try: ollama serve');
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      return;
    }

    qInput.value = '';
    qInput.style.height = '36px';
    sendBtn.disabled = true;

    const [userEl] = makeMsg('user', 'You', question);
    messages.appendChild(userEl);

    const pageText = extractPageText();
    const prompt = [
      'You are a helpful assistant. The user is reading a webpage and asks a question about it.',
      `Page title: ${document.title}`,
      `Page URL: ${location.href}`,
      '',
      'Page content:',
      pageText,
      '',
      '---',
      '',
      `User: ${question}`,
      '',
      "Answer concisely and accurately based on the page content. If the answer isn't in the content, say so briefly.",
    ].join('\n');

    const [aiEl, aiText] = makeMsg('ai', 'AI', '');
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    aiText.appendChild(cursor);
    messages.appendChild(aiEl);
    messages.scrollTop = messages.scrollHeight;

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    try {
      let resp = '';
      await streamGenerate(model, prompt, abortCtrl.signal, token => {
        resp += token;
        aiText.textContent = resp;
        aiText.appendChild(cursor);
        messages.scrollTop = messages.scrollHeight;
      });
      cursor.remove();
    } catch (err) {
      cursor.remove();
      if (err.name !== 'AbortError') {
        aiText.className = 'msg-text error';
        aiText.textContent = `Error: ${err.message}. Make sure Ollama is running (ollama serve).`;
      }
    } finally {
      sendBtn.disabled = false;
      qInput.focus();
    }
  }

  function makeMsg(type, label, text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    if (label) {
      const lbl = document.createElement('div');
      lbl.className = `msg-label ${type}`;
      lbl.textContent = label;
      wrap.appendChild(lbl);
    }
    const txt = document.createElement('div');
    txt.className = `msg-text ${type}`;
    txt.textContent = text;
    wrap.appendChild(txt);
    return [wrap, txt];
  }
})();
