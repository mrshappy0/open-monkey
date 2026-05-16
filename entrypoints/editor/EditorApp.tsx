import { useEffect, useRef, useState } from 'react';
import { parseMeta } from '../../utils/meta-parser';
import { scriptsItem } from '../../utils/storage';
import CodeEditor from '../popup/CodeEditor';

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

export default function EditorApp() {
  const scriptId = new URLSearchParams(location.search).get('id');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveLabel, setSaveLabel] = useState('Save');
  const [notFound, setNotFound] = useState(false);
  const insertIntoEditor = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    if (!scriptId) { setNotFound(true); return; }
    scriptsItem.getValue().then(scripts => {
      const script = scripts.find(s => s.id === scriptId);
      if (!script) { setNotFound(true); return; }
      setCode(script.code);
      setTitle(script.name);
    });
  }, [scriptId]);

  function insertSnippet(snippet: string) {
    if (insertIntoEditor.current) {
      insertIntoEditor.current(snippet);
    } else {
      setCode(c => c + snippet);
    }
  }

  async function save() {
    if (!scriptId || saving) return;
    setSaving(true);
    setSaveLabel('Saving…');
    const meta = parseMeta(code);
    const scripts = await scriptsItem.getValue();
    await scriptsItem.setValue(
      scripts.map(s => s.id === scriptId ? { ...s, name: meta.name, code } : s),
    );
    setTitle(meta.name);
    browser.runtime.sendMessage({ type: 'script_toggled', id: scriptId }).catch(() => {});
    setSaveLabel('Saved ✓');
    setTimeout(() => setSaveLabel('Save'), 2000);
    setSaving(false);
  }

  if (notFound) {
    return (
      <div className="editor-page">
        <p className="editor-not-found">Script not found.</p>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="editor-page-header">
        <span className="editor-page-title" title={title}>{title || '\u00a0'}</span>
        <div className="editor-page-snippets">
          <span className="editor-toolbar-label">Insert:</span>
          <button className="editor-snippet-btn" onClick={() => insertSnippet(GM_SNIPPET)}>GM storage</button>
          <button className="editor-snippet-btn" onClick={() => insertSnippet(GM_SECRET_SNIPPET)}>GM secret</button>
        </div>
        <button className="btn-primary" onClick={save} disabled={saving}>{saveLabel}</button>
      </header>
      <div className="editor-page-cm">
        <CodeEditor
          value={code}
          onChange={setCode}
          onReady={fn => { insertIntoEditor.current = fn; }}
        />
      </div>
    </div>
  );
}
