import { useEffect, useState } from 'react';
import { parseMeta, SCRIPT_TEMPLATE } from '../../utils/meta-parser';
import { scriptsItem, type UserScript } from '../../utils/storage';
import './App.css';

type View = 'list' | 'editor';

export default function App() {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorCode, setEditorCode] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    scriptsItem.getValue().then(setScripts);
    const unwatch = scriptsItem.watch(val => setScripts(val ?? []));
    return unwatch;
  }, []);

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
  }

  async function deleteScript(id: string) {
    if (!confirm('Delete this script?')) return;
    await persist(scripts.filter(s => s.id !== id));
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
    </div>
  );
}

