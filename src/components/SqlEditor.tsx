import { useCallback, useMemo, useRef } from 'react';
import { highlightSqlToHtml } from '../lib/sql-highlight';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onLoadSample: () => void;
  onLoadUpdateSample: () => void;
  onLoadDeleteSample: () => void;
  onLoadUnionSample: () => void;
  error?: string;
}

export function SqlEditor({
  value,
  onChange,
  onLoadSample,
  onLoadUpdateSample,
  onLoadDeleteSample,
  onLoadUnionSample,
  error,
}: SqlEditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);

  const highlightedHtml = useMemo(() => {
    const html = highlightSqlToHtml(value);
    return value.endsWith('\n') ? `${html} ` : html;
  }, [value]);

  const syncScroll = useCallback((target: HTMLTextAreaElement) => {
    const layer = highlightRef.current;
    if (!layer) return;
    layer.scrollTop = target.scrollTop;
    layer.scrollLeft = target.scrollLeft;
  }, []);

  return (
    <div className="sql-editor">
      <div className="sql-editor-toolbar">
        <span className="sql-editor-label">MySQL SQL</span>
        <div className="sql-editor-actions">
          <button type="button" className="btn btn--ghost" onClick={onLoadSample} title="SELECTサンプルを読み込む">
            SELECT
          </button>
          <button type="button" className="btn btn--ghost" onClick={onLoadUpdateSample} title="UPDATEサンプルを読み込む">
            UPDATE
          </button>
          <button type="button" className="btn btn--ghost" onClick={onLoadUnionSample} title="UNIONサンプルを読み込む">
            UNION
          </button>
          <button type="button" className="btn btn--ghost" onClick={onLoadDeleteSample} title="DELETEサンプルを読み込む">
            DELETE
          </button>
        </div>
      </div>
      <div className={`sql-editor-body${error ? ' sql-editor-body--error' : ''}`}>
        <pre ref={highlightRef} className="sql-highlight-layer" aria-hidden="true">
          <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        </pre>
        <textarea
          className="sql-textarea sql-textarea--highlight"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => syncScroll(e.currentTarget)}
          placeholder="SELECT / UPDATE / DELETE ..."
          spellCheck={false}
        />
      </div>
      {error && (
        <div className="parse-error" role="alert">
          <strong>解析エラー:</strong> {error}
        </div>
      )}
    </div>
  );
}
