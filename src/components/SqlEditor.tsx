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
      <textarea
        className={`sql-textarea${error ? ' sql-textarea--error' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="SELECT / UPDATE / DELETE ..."
        spellCheck={false}
      />
      {error && (
        <div className="parse-error" role="alert">
          <strong>解析エラー:</strong> {error}
        </div>
      )}
    </div>
  );
}
