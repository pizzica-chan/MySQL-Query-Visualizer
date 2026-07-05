interface SampleLoadButtonsProps {
  onSelect: () => void;
  onUpdate: () => void;
  onUnion: () => void;
  onDelete: () => void;
  /** welcome 画面などで SELECT を強調する */
  highlightSelect?: boolean;
}

const SAMPLES = [
  { id: 'select', label: 'SELECT', title: 'SELECT のサンプル SQL を読み込む', handler: 'onSelect' as const },
  { id: 'union', label: 'UNION', title: 'UNION のサンプル SQL を読み込む', handler: 'onUnion' as const },
  { id: 'update', label: 'UPDATE', title: 'UPDATE のサンプル SQL を読み込む', handler: 'onUpdate' as const },
  { id: 'delete', label: 'DELETE', title: 'DELETE のサンプル SQL を読み込む', handler: 'onDelete' as const },
] as const;

export function SampleLoadButtons({
  onSelect,
  onUpdate,
  onUnion,
  onDelete,
  highlightSelect = false,
}: SampleLoadButtonsProps) {
  const handlers = { onSelect, onUpdate, onUnion, onDelete };

  return (
    <div className="sample-load">
      <span className="sample-load-label">サンプル SQL</span>
      <div className="sample-load-buttons">
        {SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className={`btn sample-load-btn${
              highlightSelect && sample.id === 'select' ? ' btn--primary' : ' btn--ghost'
            }`}
            onClick={handlers[sample.handler]}
            title={sample.title}
          >
            {sample.label}
          </button>
        ))}
      </div>
    </div>
  );
}
