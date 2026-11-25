import { IconCompare, IconJoin, IconNarrative, IconStructure } from './Icons';

interface WelcomePanelProps {
  onSelect: () => void;
  onUnion: () => void;
  onUpdate: () => void;
  onDelete: () => void;
}

/** サンプルの中身を一言で示す。説明は src/lib/parser.ts のサンプル SQL に合わせる */
const SAMPLES = [
  { id: 'select', label: 'SELECT', desc: '多段 JOIN・派生テーブル・EXISTS / IN / NOT IN', handler: 'onSelect' },
  { id: 'union', label: 'UNION', desc: 'ブランチごとの JOIN・集約・サブクエリ', handler: 'onUnion' },
  { id: 'update', label: 'UPDATE', desc: 'JOIN した 3 テーブルの列を一度に更新', handler: 'onUpdate' },
  { id: 'delete', label: 'DELETE', desc: 'JOIN した 2 テーブルから一度に削除', handler: 'onDelete' },
] as const;

const FEATURES = [
  { icon: IconStructure, title: 'SQL構造', desc: '句ごとに分けて表示。クリックで SQL の該当箇所へ' },
  { icon: IconNarrative, title: '作用説明', desc: 'どの行を返す・変えるかを日本語で説明' },
  { icon: IconJoin, title: 'JOIN 図', desc: 'テーブルの結合をグラフで表示' },
  { icon: IconCompare, title: 'SQL前後比較', desc: '書き換えで結果が変わりそうな差分を確認' },
] as const;

/** 単一解析で SQL が未入力のときの表示 */
export function WelcomePanel(props: WelcomePanelProps) {
  return (
    <div className="welcome-state">
      <div className="welcome-hero">
        <svg className="welcome-illustration" viewBox="0 0 240 120" aria-hidden="true" focusable="false">
          <path className="welcome-illustration-edge" d="M78 42c30 0 30 36 62 36" />
          <path className="welcome-illustration-edge welcome-illustration-edge--dashed" d="M78 42c30 0 32-20 62-20" />
          <g className="welcome-illustration-node">
            <rect x="18" y="22" width="60" height="40" rx="6" />
            <rect x="18" y="22" width="60" height="11" rx="6" className="welcome-illustration-head" />
          </g>
          <g className="welcome-illustration-node">
            <rect x="140" y="4" width="60" height="36" rx="6" />
            <rect x="140" y="4" width="60" height="11" rx="6" className="welcome-illustration-head" />
          </g>
          <g className="welcome-illustration-node">
            <rect x="140" y="60" width="60" height="40" rx="6" />
            <rect x="140" y="60" width="60" height="11" rx="6" className="welcome-illustration-head welcome-illustration-head--alt" />
          </g>
        </svg>
        <h2 className="welcome-title">SQL を入力して解析を始めましょう</h2>
        <p className="welcome-hint">
          左のエディタに SELECT / UPDATE / DELETE を貼り付けるか、サンプルを読み込んでください。SQL はブラウザの外へ送りません。
        </p>
      </div>

      <div className="welcome-samples" role="group" aria-label="サンプル SQL">
        {SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className={`sample-card sample-load-btn${sample.id === 'select' ? ' sample-card--primary' : ''}`}
            onClick={props[sample.handler]}
            title={`${sample.label} のサンプル SQL を読み込む`}
          >
            <span className="sample-card-label">{sample.label}</span>
            <span className="sample-card-desc">{sample.desc}</span>
          </button>
        ))}
      </div>

      <ul className="welcome-features">
        {FEATURES.map(({ icon: FeatureIcon, title, desc }) => (
          <li key={title} className="welcome-feature">
            <span className="welcome-feature-icon">
              <FeatureIcon size={16} />
            </span>
            <span>
              <strong>{title}</strong>
              <span className="welcome-feature-desc">{desc}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
