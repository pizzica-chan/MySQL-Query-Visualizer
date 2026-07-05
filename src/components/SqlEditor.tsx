import { useCallback, useEffect, useMemo, useRef } from 'react';
import { highlightSqlToHtml } from '../lib/sql-highlight';
import type { SourceSpan } from '../lib/types';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onLoadSample: () => void;
  onLoadUpdateSample: () => void;
  onLoadDeleteSample: () => void;
  onLoadUnionSample: () => void;
  error?: string;
  focusSpan?: SourceSpan | null;
}

export function SqlEditor({
  value,
  onChange,
  onLoadSample,
  onLoadUpdateSample,
  onLoadDeleteSample,
  onLoadUnionSample,
  error,
  focusSpan = null,
}: SqlEditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const highlightedHtml = useMemo(() => {
    const html = highlightSqlToHtml(value, focusSpan ?? undefined);
    return value.endsWith('\n') ? `${html} ` : html;
  }, [value, focusSpan]);

  const syncScroll = useCallback((target: HTMLTextAreaElement) => {
    const layer = highlightRef.current;
    if (!layer) return;
    layer.scrollTop = target.scrollTop;
    layer.scrollLeft = target.scrollLeft;
  }, []);

  useEffect(() => {
    if (!focusSpan || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
    const textBefore = value.slice(0, focusSpan.start);
    const line = textBefore.split('\n').length - 1;
    const targetTop = Math.max(0, line * lineHeight - textarea.clientHeight * 0.35);
    textarea.scrollTop = targetTop;
    syncScroll(textarea);
  }, [focusSpan, value, syncScroll]);

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
          ref={textareaRef}
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
