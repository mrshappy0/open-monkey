import { useEffect, useRef, useState } from 'react';
import { parseMeta, SCRIPT_TEMPLATE } from '../../utils/meta-parser';
import { scriptsItem, settingsItem, scriptStoreItem, type UserScript, type ScriptStore } from '../../utils/storage';
import './App.css';

type View = 'list' | 'editor' | 'store';

const GM_SNIPPET = `
  // GM storage — persistent, survives tab/browser restarts. Namespaced to this script.
  const value = await GM_getValue('myKey', 'default');
  await GM_setValue('myKey', 'newValue');
  await GM_deleteValue('myKey');
  const keys = await GM_listValues();
`;

const GM_SECRET_SNIPPET = `
  // Secret values are masked as •••••••• in the popup Script Data view
  await GM_setValue('apiKey', 'sk-...', true);
  const apiKey = await GM_getValue('apiKey', '');
`;

export default function App() {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorCode, setEditorCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [maxRetries, setMaxRetries] = useState(3);
  const [bridgeConnected, setBridgeConnected] = useState<boolean | null>(null);
  const [storeData, setStoreData] = useState<ScriptStore>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editingEntry, setEditingEntry] = useState<{ ns: string; key: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingSecret, setEditingSecret] = useState(false);
  const [addingToNs, setAddingToNs] = useState<string | null>(null);
  const [newEntryKey, setNewEntryKey] = useState('');
  const [newEntryValue, setNewEntryValue] = useState('');
  const [newEntrySecret, setNewEntrySecret] = useState(false);

  useEffect(() => {
    scriptsItem.getValue().then(setScripts);
    settingsItem.getValue().then(s => setMaxRetries(s.maxRetries));
    const unwatch = scriptsItem.watch(val => setScripts(val ?? []));

    // Query current bridge state, then watch for live changes.
    browser.runtime.sendMessage({ type: 'get_bridge_status' })
      .then((res: unknown) => {
        setBridgeConnected((res as { connected: boolean } | null)?.connected ?? false);
      })
      .catch(() => setBridgeConnected(false));

    const onBridgeMessage = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'bridge_status') {
        setBridgeConnected((msg as { connected: boolean }).connected);
      }
    };
    browser.runtime.onMessage.addListener(onBridgeMessage);

    scriptStoreItem.getValue().then(setStoreData);
    const unwatchStore = scriptStoreItem.watch(val => setStoreData(val ?? {}));

    return () => {
      unwatch();
      unwatchStore();
      browser.runtime.onMessage.removeListener(onBridgeMessage);
    };
  }, []);

  async function saveMaxRetries(value: number) {
    const clamped = Math.max(0, Math.min(10, value));
    setMaxRetries(clamped);
    await settingsItem.setValue({ maxRetries: clamped });
  }

  async function persist(updated: UserScript[]) {
    await scriptsItem.setValue(updated);
    // watcher fires automatically → no manual setScripts needed
  }

  function openEditor(script?: UserScript) {
    setEditingId(script?.id ?? null);
    setEditorCode(script?.code ?? SCRIPT_TEMPLATE);
    setView('editor');
  }

  async function saveScript() {
    setSaving(true);
    const meta = parseMeta(editorCode);
    let savedId: string;
    if (editingId) {
      savedId = editingId;
      await persist(
        scripts.map(s =>
          s.id === editingId ? { ...s, name: meta.name, code: editorCode } : s,
        ),
      );
    } else {
      savedId = crypto.randomUUID();
      await persist([
        ...scripts,
        { id: savedId, name: meta.name, enabled: true, code: editorCode },
      ]);
    }
    // Reload the active tab if the script matches its URL — same behaviour as toggling.
    browser.runtime.sendMessage({ type: 'script_toggled', id: savedId }).catch(() => {});
    setSaving(false);
    setView('list');
  }

  async function toggleEnabled(id: string) {
    await persist(scripts.map(s => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    browser.runtime.sendMessage({ type: 'script_toggled', id }).catch(() => {});
  }

  async function deleteScript(id: string) {
    if (!confirm('Delete this script?')) return;
    await persist(scripts.filter(s => s.id !== id));
    // Also wipe this script's stored variables so orphaned data doesn't accumulate.
    if (storeData[id]) {
      const updated = { ...storeData };
      delete updated[id];
      await scriptStoreItem.setValue(updated);
    }
  }

  function toggleReveal(entryKey: string) {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(entryKey)) { next.delete(entryKey); } else { next.add(entryKey); }
      return next;
    });
  }

  async function deleteStoreEntry(namespace: string, key: string) {
    const updated = { ...storeData };
    const ns = { ...(updated[namespace] ?? {}) };
    delete ns[key];
    if (Object.keys(ns).length === 0) {
      delete updated[namespace];
    } else {
      updated[namespace] = ns;
    }
    await scriptStoreItem.setValue(updated);
  }

  async function updateStoreEntry(namespace: string, key: string, value: unknown, secret: boolean) {
    // eslint-disable-next-line react-hooks/purity -- event handler, not called during render
    const updatedAt = Date.now();
    await scriptStoreItem.setValue({
      ...storeData,
      [namespace]: {
        ...(storeData[namespace] ?? {}),
        [key]: { value, secret, updatedAt },
      },
    });
  }

  async function addStoreEntry() {
    const key = newEntryKey.trim();
    if (!key || !addingToNs) return;
    await updateStoreEntry(addingToNs, key, newEntryValue, newEntrySecret);
    setAddingToNs(null);
    setNewEntryKey('');
    setNewEntryValue('');
    setNewEntrySecret(false);
  }

  const editorRef = useRef<HTMLTextAreaElement>(null);

  function insertSnippet(snippet: string) {
    const ta = editorRef.current;
    if (!ta) { setEditorCode(c => c + snippet); return; }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = editorCode.slice(0, start) + snippet + editorCode.slice(end);
    setEditorCode(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + snippet.length;
    });
  }

  if (view === 'store') {
    return (
      <div className="app">
        <header className="header">
          <button className="btn-text" onClick={() => setView('list')}>← Back</button>
          <span className="header-title">Script Data</span>
          <select
            className="store-script-select"
            value=""
            onChange={e => {
              const id = e.target.value;
              if (id) { setAddingToNs(id); setNewEntryKey(''); setNewEntryValue(''); setNewEntrySecret(false); }
            }}
          >
            <option value="">+ Add to…</option>
            {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </header>
        <main className="store-list">
          {Object.keys(storeData).length === 0 && !addingToNs && (
            <p className="empty">No script data stored yet. Use “+ Add to…” above or let a script call GM_setValue to populate this view.</p>
          )}
          {Object.entries(storeData).map(([ns, entries]) => (
            <div key={ns} className="store-ns">
              <div className="store-ns-header">
                <span className="store-ns-name" title={ns}>{scripts.find(s => s.id === ns)?.name ?? ns}</span>
                <button
                  className="store-add-btn"
                  onClick={() => { setAddingToNs(ns); setNewEntryKey(''); setNewEntryValue(''); setNewEntrySecret(false); }}
                >+ Add</button>
              </div>
              {Object.entries(entries).map(([key, entry]) => {
                const revealKey = `${ns}:${key}`;
                const isRevealed = revealed.has(revealKey);
                const isEditing = editingEntry?.ns === ns && editingEntry?.key === key;
                return (
                  <div key={key} className="store-entry">
                    <span className="store-key" title={key}>{key}</span>
                    {isEditing ? (
                      <>
                        <input
                          className="store-edit-input"
                          value={editingValue}
                          onChange={e => setEditingValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') updateStoreEntry(ns, key, editingValue, editingSecret).then(() => setEditingEntry(null));
                            if (e.key === 'Escape') setEditingEntry(null);
                          }}
                          autoFocus
                        />
                        <button
                          className={`store-secret-btn${editingSecret ? ' active' : ''}`}
                          onClick={() => setEditingSecret(s => !s)}
                          title={editingSecret ? 'Remove secret flag' : 'Mark as secret'}
                        >🔒</button>
                        <button className="action-btn" onClick={() => updateStoreEntry(ns, key, editingValue, editingSecret).then(() => setEditingEntry(null))}>✓</button>
                        <button className="action-btn" onClick={() => setEditingEntry(null)}>✕</button>
                      </>
                    ) : (
                      <>
                        <span
                          className={`store-value${entry.secret && !isRevealed ? ' store-value--masked' : ''}`}
                          onClick={() => { setEditingEntry({ ns, key }); setEditingValue(String(entry.value)); setEditingSecret(entry.secret); }}
                          title="Click to edit"
                          style={{ cursor: 'pointer' }}
                        >
                          {entry.secret && !isRevealed ? '••••••••' : String(entry.value)}
                        </span>
                        {entry.secret && (
                          <button
                            className="action-btn"
                            onClick={() => toggleReveal(revealKey)}
                            title={isRevealed ? 'Hide' : 'Reveal'}
                            aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                          >
                            {isRevealed ? '🙈' : '👁'}
                          </button>
                        )}
                        <button
                          className="action-btn"
                          onClick={() => { setEditingEntry({ ns, key }); setEditingValue(String(entry.value)); setEditingSecret(entry.secret); }}
                          title="Edit"
                        >✎</button>
                        <button
                          className="action-btn danger"
                          onClick={() => deleteStoreEntry(ns, key)}
                          aria-label={`Delete ${key}`}
                        >✕</button>
                      </>
                    )}
                  </div>
                );
              })}
              {addingToNs === ns && (
                <div className="store-entry store-add-row">
                  <input
                    className="store-new-key"
                    placeholder="key"
                    value={newEntryKey}
                    onChange={e => setNewEntryKey(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setAddingToNs(null); }}
                    autoFocus
                  />
                  <input
                    className="store-edit-input"
                    placeholder="value"
                    value={newEntryValue}
                    onChange={e => setNewEntryValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addStoreEntry();
                      if (e.key === 'Escape') setAddingToNs(null);
                    }}
                    type={newEntrySecret ? 'password' : 'text'}
                  />
                  <button
                    className={`store-secret-btn${newEntrySecret ? ' active' : ''}`}
                    onClick={() => setNewEntrySecret(s => !s)}
                    title={newEntrySecret ? 'Remove secret flag' : 'Mark as secret'}
                  >🔒</button>
                  <button className="action-btn" onClick={() => addStoreEntry()} disabled={!newEntryKey.trim()}>+</button>
                  <button className="action-btn" onClick={() => setAddingToNs(null)}>✕</button>
                </div>
              )}
            </div>
          ))}
          {/* New-namespace row — for scripts that have no stored data yet */}
          {addingToNs && !storeData[addingToNs] && (
            <div className="store-ns">
              <div className="store-ns-header">
                <span className="store-ns-name">{scripts.find(s => s.id === addingToNs)?.name ?? addingToNs}</span>
              </div>
              <div className="store-entry store-add-row">
                <input
                  className="store-new-key"
                  placeholder="key"
                  value={newEntryKey}
                  onChange={e => setNewEntryKey(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setAddingToNs(null); }}
                  autoFocus
                />
                <input
                  className="store-edit-input"
                  placeholder="value"
                  value={newEntryValue}
                  onChange={e => setNewEntryValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addStoreEntry();
                    if (e.key === 'Escape') setAddingToNs(null);
                  }}
                  type={newEntrySecret ? 'password' : 'text'}
                />
                <button
                  className={`store-secret-btn${newEntrySecret ? ' active' : ''}`}
                  onClick={() => setNewEntrySecret(s => !s)}
                  title={newEntrySecret ? 'Remove secret flag' : 'Mark as secret'}
                >🔒</button>
                <button className="action-btn" onClick={() => addStoreEntry()} disabled={!newEntryKey.trim()}>+</button>
                <button className="action-btn" onClick={() => setAddingToNs(null)}>✕</button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  if (view === 'editor') {
    return (
      <div className="app">
        <header className="header">
          <button className="btn-text" onClick={() => setView('list')}>
            ← Back
          </button>
          <span className="header-title">{editingId ? 'Edit Script' : 'New Script'}</span>
          <button className="btn-primary" onClick={saveScript} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>
        <div className="editor-toolbar">
          <span className="editor-toolbar-label">Insert:</span>
          <button className="editor-snippet-btn" onClick={() => insertSnippet(GM_SNIPPET)}>GM storage</button>
          <button className="editor-snippet-btn" onClick={() => insertSnippet(GM_SECRET_SNIPPET)}>GM secret</button>
        </div>
        <textarea
          ref={editorRef}
          className="editor"
          value={editorCode}
          onChange={e => setEditorCode(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <span className="logo">🐒 OpenMonkey</span>
        <span className={`bridge-badge${bridgeConnected === true ? ' bridge-badge--on' : ' bridge-badge--off'}`}>
          <span className="bridge-badge__dot" />
          MCP {bridgeConnected === true ? 'connected' : 'disconnected'}
        </span>
        <button className="btn-primary" onClick={() => openEditor()}>
          + New
        </button>
      </header>
      <main className="script-list">
        {scripts.length === 0 && (
          <p className="empty">No scripts yet. Click + New to add one.</p>
        )}
        {scripts.map(script => (
          <div key={script.id} className={`script-item ${script.enabled ? 'enabled' : 'disabled'}`}>
            <button
              className={`toggle ${script.enabled ? 'on' : 'off'}`}
              onClick={() => toggleEnabled(script.id)}
              title={script.enabled ? 'Click to disable' : 'Click to enable'}
              aria-label={script.enabled ? 'Disable script' : 'Enable script'}
            />
            <span className="script-name" title={script.name}>
              {script.name}
            </span>
            <div className="actions">
              <button className="action-btn" onClick={() => openEditor(script)}>
                Edit
              </button>
              <button
                className="action-btn danger"
                onClick={() => deleteScript(script.id)}
                aria-label="Delete script"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </main>
      <footer className="settings-footer">
        <button className="btn-text" onClick={() => setView('store')}>Script Data</button>
        <span className="settings-label">Max retries</span>
        <input
          className="settings-input"
          type="number"
          min={0}
          max={10}
          value={maxRetries}
          onChange={e => saveMaxRetries(parseInt(e.target.value, 10) || 0)}
          title="How many times a script may run on the same page before stopping (0 = unlimited). Override per-script with @max-retries N."
        />
      </footer>
    </div>
  );
}

