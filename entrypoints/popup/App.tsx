import { useEffect, useState } from 'react';
import { parseMeta, SCRIPT_TEMPLATE } from '../../utils/meta-parser';
import { scriptsItem, settingsItem, scriptStoreItem, type UserScript, type ScriptStore } from '../../utils/storage';
import './App.css';

type View = 'list' | 'editor' | 'store';

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
    if (editingId) {
      await persist(
        scripts.map(s =>
          s.id === editingId ? { ...s, name: meta.name, code: editorCode } : s,
        ),
      );
    } else {
      await persist([
        ...scripts,
        { id: crypto.randomUUID(), name: meta.name, enabled: true, code: editorCode },
      ]);
    }
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
  }

  function toggleReveal(entryKey: string) {
    setRevealed(prev => {
      const next = new Set(prev);
      next.has(entryKey) ? next.delete(entryKey) : next.add(entryKey);
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

  if (view === 'store') {
    return (
      <div className="app">
        <header className="header">
          <button className="btn-text" onClick={() => setView('list')}>← Back</button>
          <span className="header-title">Script Data</span>
        </header>
        <main className="store-list">
          {Object.keys(storeData).length === 0 && (
            <p className="empty">No script data stored yet.</p>
          )}
          {Object.entries(storeData).map(([ns, entries]) => (
            <div key={ns} className="store-ns">
              <div className="store-ns-header">
                <span className="store-ns-name">{ns}</span>
              </div>
              {Object.entries(entries).map(([key, entry]) => {
                const revealKey = `${ns}:${key}`;
                const isRevealed = revealed.has(revealKey);
                return (
                  <div key={key} className="store-entry">
                    <span className="store-key">{key}</span>
                    <span className={`store-value${entry.secret && !isRevealed ? ' store-value--masked' : ''}`}>
                      {entry.secret && !isRevealed ? '••••••••' : String(entry.value)}
                    </span>
                    {entry.secret && (
                      <button
                        className="action-btn"
                        onClick={() => toggleReveal(revealKey)}
                        title={isRevealed ? 'Hide' : 'Reveal'}
                      >
                        {isRevealed ? '🙈' : '👁'}
                      </button>
                    )}
                    <button
                      className="action-btn danger"
                      onClick={() => deleteStoreEntry(ns, key)}
                      aria-label={`Delete ${key}`}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
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
        <textarea
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

