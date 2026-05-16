import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';

// Override oneDark colours to match the Catppuccin Mocha UI palette used
// throughout the popup. Placed after oneDark in the extensions array so its
// rules are inserted later in the cascade and win on equal specificity.
const mochaOverride = EditorView.theme(
  {
    '&': { backgroundColor: '#11111b' },
    '.cm-content': { padding: '12px 14px', lineHeight: '1.65', caretColor: '#cdd6f4' },
    '.cm-gutters': {
      backgroundColor: '#181825',
      color: '#45475a',
      border: 'none',
      borderRight: '1px solid #313244',
    },
    '.cm-activeLineGutter': { backgroundColor: '#1e1e2e', color: '#7f849c' },
    '.cm-activeLine': { backgroundColor: 'rgba(49, 50, 68, 0.25)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#313244 !important',
    },
    '.cm-cursor': { borderLeftColor: '#cdd6f4' },
    '.cm-scroller': {
      fontFamily:
        "ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      fontSize: '12px',
    },
    /* lint gutter */
    '.cm-gutter-lint': { width: '14px' },
    '.cm-lint-marker-error': { content: '', display: 'block', width: '6px', height: '6px',
      borderRadius: '50%', backgroundColor: '#f38ba8', margin: '0 auto' },
  },
  { dark: true },
);

// Walk the lezer syntax tree for error-recovery nodes — these are spots the
// parser couldn't make sense of, i.e. genuine JS syntax errors.
const jsLinter = linter(view => {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state).cursor().iterate(node => {
    if (node.type.isError) {
      diagnostics.push({
        from: node.from,
        to: Math.max(node.to, node.from + 1),
        severity: 'error',
        message: 'Syntax error',
      });
    }
  });
  return diagnostics;
});

const staticExtensions = [
  lineNumbers(),
  lintGutter(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  highlightActiveLine(),
  keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
  javascript({ jsx: false, typescript: false }),
  jsLinter,
  oneDark,
  mochaOverride,
  EditorState.tabSize.of(2),
];

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onReady: (insertFn: (text: string) => void) => void;
}

export default function CodeEditor({ value, onChange, onReady }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep a ref so the updateListener never captures a stale onChange.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          ...staticExtensions,
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;

    onReady((text: string) => {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []); // intentionally mount/unmount only; value synced below

  // Sync when the user opens a different script in the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={containerRef} className="cm-editor-wrapper" />;
}
