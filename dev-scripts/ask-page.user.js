// ==UserScript==
// @name         Ask AI — Page Q&A
// @description  Floating button on every page — ask AI about the current page. Supports Ollama (local) and any cloud LLM with an OpenAI-compatible API (OpenAI, Anthropic, GitHub Copilot, Mistral, etc.).
// @match        *://*/*
// @run-at       document-end
// @version      1.0.0
// ==/UserScript==

(function () {
  'use strict';

  const OLLAMA_BASE = 'http://localhost:11434';
  const HOST_ID = 'om-ask-host';
  const MAX_PAGE_CHARS = 8000;
  const LS_KEY = 'om-ask-cfg';

  if (document.getElementById(HOST_ID)) return;

  // ── Config helpers ──────────────────────────────────────────────────────

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function saveCfg(patch) {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...loadCfg(), ...patch }));
  }

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

  // streamChat routes through the ask-proxy content script → background service
  // worker, which makes the cross-origin fetch without CORS restrictions.
  function streamChat(endpoint, apiKey, model, msgs, signal, onToken) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);

      function onTokenEvt(e) {
        if (e.detail.id !== id) return;
        onToken(e.detail.content);
      }
      function onDoneEvt(e) {
        if (e.detail.id !== id) return;
        cleanup();
        resolve();
      }
      function onErrorEvt(e) {
        if (e.detail.id !== id) return;
        cleanup();
        reject(new Error(e.detail.message));
      }
      function cleanup() {
        window.removeEventListener('om-ask-token', onTokenEvt);
        window.removeEventListener('om-ask-done', onDoneEvt);
        window.removeEventListener('om-ask-error', onErrorEvt);
      }

      window.addEventListener('om-ask-token', onTokenEvt);
      window.addEventListener('om-ask-done', onDoneEvt);
      window.addEventListener('om-ask-error', onErrorEvt);

      signal.addEventListener('abort', () => {
        window.dispatchEvent(new CustomEvent('om-ask-abort', { detail: { id } }));
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      });

      window.dispatchEvent(new CustomEvent('om-ask-request', {
        detail: { id, endpoint, apiKey, model, messages: msgs },
      }));
    });
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

    #gear-btn {
      background: none; border: none; color: #8b949e; font-size: 15px; padding: 2px 6px;
      border-radius: 4px; transition: color .15s; flex-shrink: 0;
    }
    #gear-btn:hover { color: #e6edf3; }
    #gear-btn.active { color: #58a6ff; }
    #api-badge {
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      color: #8b949e; font-size: 11px; padding: 3px 8px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 130px; display: none;
    }
    #settings-panel {
      padding: 12px 14px; border-bottom: 1px solid #21262d;
      display: none; flex-direction: column; gap: 10px; flex-shrink: 0;
    }
    #settings-panel.open { display: flex; }
    .srow { display: flex; flex-direction: column; gap: 4px; }
    .slabel { font-size: 11px; color: #8b949e; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .prov-row { display: flex; gap: 6px; }
    .prov-btn {
      flex: 1; padding: 5px 8px; border: 1px solid #30363d; border-radius: 6px;
      background: #161b22; color: #8b949e; font-size: 12px; font-weight: 600; transition: all .15s;
    }
    .prov-btn.active { border-color: #58a6ff; color: #58a6ff; background: rgba(88,166,255,.08); }
    .sinput {
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; font-size: 12px; padding: 5px 8px; outline: none; width: 100%; font-family: inherit;
    }
    .sinput:focus { border-color: #58a6ff; }
    .sinput::placeholder { color: #484f58; }
    .api-fields { display: none; flex-direction: column; gap: 10px; }
    .api-fields.visible { display: flex; }
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
  const apiBadge = document.createElement('span');
  apiBadge.id = 'api-badge';
  header.appendChild(apiBadge);
  const gearBtn = document.createElement('button');
  gearBtn.id = 'gear-btn';
  gearBtn.textContent = '⚙';
  gearBtn.title = 'Settings';
  header.appendChild(gearBtn);
  panel.appendChild(header);

  // Settings panel
  const settingsPanel = document.createElement('div');
  settingsPanel.id = 'settings-panel';

  const provRow = document.createElement('div');
  provRow.className = 'srow';
  const provLabel = document.createElement('div');
  provLabel.className = 'slabel';
  provLabel.textContent = 'Provider';
  const provBtns = document.createElement('div');
  provBtns.className = 'prov-row';
  const ollamaBtn = document.createElement('button');
  ollamaBtn.className = 'prov-btn';
  ollamaBtn.dataset.prov = 'ollama';
  ollamaBtn.textContent = 'Ollama (local)';
  const apiProvBtn = document.createElement('button');
  apiProvBtn.className = 'prov-btn';
  apiProvBtn.dataset.prov = 'api';
  apiProvBtn.textContent = 'Cloud API';
  provBtns.appendChild(ollamaBtn);
  provBtns.appendChild(apiProvBtn);
  provRow.appendChild(provLabel);
  provRow.appendChild(provBtns);
  settingsPanel.appendChild(provRow);

  const apiFields = document.createElement('div');
  apiFields.className = 'api-fields';

  const endpointRow = document.createElement('div');
  endpointRow.className = 'srow';
  const endpointLabel = document.createElement('div');
  endpointLabel.className = 'slabel';
  endpointLabel.textContent = 'Endpoint';
  const endpointInput = document.createElement('input');
  endpointInput.className = 'sinput';
  endpointInput.placeholder = 'https://api.openai.com';
  endpointInput.type = 'url';
  endpointRow.appendChild(endpointLabel);
  endpointRow.appendChild(endpointInput);
  apiFields.appendChild(endpointRow);

  const keyRow = document.createElement('div');
  keyRow.className = 'srow';
  const keyLabel = document.createElement('div');
  keyLabel.className = 'slabel';
  keyLabel.textContent = 'API Key';
  const keyInput = document.createElement('input');
  keyInput.className = 'sinput';
  keyInput.placeholder = 'Bearer token / API key';
  keyInput.type = 'password';
  keyRow.appendChild(keyLabel);
  keyRow.appendChild(keyInput);
  apiFields.appendChild(keyRow);

  const apiModelRow = document.createElement('div');
  apiModelRow.className = 'srow';
  const apiModelLabel = document.createElement('div');
  apiModelLabel.className = 'slabel';
  apiModelLabel.textContent = 'Model';
  const apiModelInput = document.createElement('input');
  apiModelInput.className = 'sinput';
  apiModelInput.placeholder = 'gpt-4o, claude-opus-4-5, …';
  apiModelInput.type = 'text';
  apiModelRow.appendChild(apiModelLabel);
  apiModelRow.appendChild(apiModelInput);
  apiFields.appendChild(apiModelRow);

  settingsPanel.appendChild(apiFields);
  panel.appendChild(settingsPanel);

  // Messages
  const messages = document.createElement('div');
  messages.id = 'messages';
  const hintEl = makeMsg('hint', null, 'Ask anything about this page — the full content is included as context. Supports Ollama (local) or any cloud LLM with an OpenAI-compatible API (OpenAI, Anthropic, GitHub Copilot, Mistral, and more).');
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

  // ── Provider / settings helpers ─────────────────────────────────────────

  function applyProvider(prov) {
    const isApi = prov === 'api';
    modelSelect.style.display = isApi ? 'none' : '';
    apiBadge.style.display = isApi ? '' : 'none';
    ollamaBtn.classList.toggle('active', !isApi);
    apiProvBtn.classList.toggle('active', isApi);
    apiFields.classList.toggle('visible', isApi);
    if (isApi) apiBadge.textContent = loadCfg().apiModel || 'API';
  }

  (function initSettings() {
    const cfg = loadCfg();
    endpointInput.value = cfg.apiEndpoint || 'https://api.openai.com';
    keyInput.value = cfg.apiKey || '';
    apiModelInput.value = cfg.apiModel || '';
    applyProvider(cfg.provider || 'ollama');
  })();

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

  // ── Settings logic ──────────────────────────────────────────────────────

  gearBtn.addEventListener('click', () => {
    const isOpen = settingsPanel.classList.toggle('open');
    gearBtn.classList.toggle('active', isOpen);
  });

  [ollamaBtn, apiProvBtn].forEach(btn => {
    btn.addEventListener('click', () => {
      const prov = btn.dataset.prov;
      saveCfg({ provider: prov });
      applyProvider(prov);
    });
  });

  function saveApiFields() {
    saveCfg({
      apiEndpoint: endpointInput.value.trim() || 'https://api.openai.com',
      apiKey: keyInput.value.trim(),
      apiModel: apiModelInput.value.trim(),
    });
    apiBadge.textContent = apiModelInput.value.trim() || 'API';
  }
  endpointInput.addEventListener('change', saveApiFields);
  keyInput.addEventListener('change', saveApiFields);
  apiModelInput.addEventListener('change', saveApiFields);

  [endpointInput, keyInput, apiModelInput].forEach(el => {
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
    el.addEventListener('keypress', e => e.stopPropagation());
  });

  // ── Auto-resize textarea ─────────────────────────────────────────────────

  qInput.addEventListener('input', () => {
    qInput.style.height = 'auto';
    qInput.style.height = Math.min(qInput.scrollHeight, 96) + 'px';
    qInput.style.overflowY = qInput.scrollHeight > 96 ? 'auto' : 'hidden';
  });

  // ── Send ─────────────────────────────────────────────────────────────────

  // Stop keyboard events from bubbling to the page (prevents page shortcuts like GitHub's 's')
  qInput.addEventListener('keydown', e => e.stopPropagation());
  qInput.addEventListener('keyup', e => e.stopPropagation());
  qInput.addEventListener('keypress', e => e.stopPropagation());

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

    const cfg = loadCfg();
    const isApi = cfg.provider === 'api';
    const model = isApi ? cfg.apiModel : modelSelect.value;
    const effectiveEndpoint = cfg.apiEndpoint || 'https://api.openai.com';

    if (!model) {
      const msg = isApi
        ? 'No model configured. Open ⚙ settings and enter a model name.'
        : 'No model selected. Is Ollama running? Try: ollama serve';
      const [el] = makeMsg('error', null, msg);
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
    const systemContent = [
      'You are a helpful assistant. The user is reading a webpage and asks a question about it.',
      `Page title: ${document.title}`,
      `Page URL: ${location.href}`,
      '',
      'Page content:',
      pageText,
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
      const onToken = token => {
        resp += token;
        aiText.textContent = resp;
        aiText.appendChild(cursor);
        messages.scrollTop = messages.scrollHeight;
      };
      if (isApi) {
        await streamChat(
          effectiveEndpoint, cfg.apiKey, model,
          [{ role: 'system', content: systemContent }, { role: 'user', content: question }],
          abortCtrl.signal, onToken
        );
      } else {
        const prompt = `${systemContent}\n\n---\n\nUser: ${question}\n`;
        await streamGenerate(model, prompt, abortCtrl.signal, onToken);
      }
      cursor.remove();
    } catch (err) {
      cursor.remove();
      if (err.name !== 'AbortError') {
        aiText.className = 'msg-text error';
        aiText.textContent = `Error: ${err.message}`;
        if (!isApi) aiText.textContent += '. Make sure Ollama is running (ollama serve).';
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
