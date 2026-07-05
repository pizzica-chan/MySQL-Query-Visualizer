# MySQL Query Visualizer

MySQL の SELECT 文を貼り付けると、JOIN 関係と WHERE / HAVING 条件を視覚的に表示する Web UI です。

## 機能

- **JOIN 図** — テーブル間の結合関係をインタラクティブなグラフで表示
- **WHERE / HAVING ツリー** — AND / OR / NOT などの論理構造をツリー形式で表示
- **概要** — テーブル一覧、SELECT 列、GROUP BY、ORDER BY、LIMIT などのサマリー
- **リアルタイム解析** — 入力後 400ms で自動解析

## 起動方法

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 を開いてください。

## ビルド

```bash
npm run build
npm run preview
```

## 対応範囲

- MySQL 形式の **SELECT** 文
- INNER / LEFT / RIGHT / FULL / CROSS JOIN
- WHERE / HAVING の比較・IN・BETWEEN・LIKE・IS NULL・EXISTS
- GROUP BY / ORDER BY / LIMIT / DISTINCT

## 技術スタック

- React 19 + TypeScript + Vite
- [node-sql-parser](https://github.com/taozhi8833990/node-sql-parser) — MySQL AST 解析
- [@xyflow/react](https://reactflow.dev/) — JOIN 関係のグラフ表示
