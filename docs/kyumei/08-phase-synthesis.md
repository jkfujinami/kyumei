# 08. Phase: Synthesis / レポート生成

Frontier収束後(または予算到達後)に必ず1回走る終端フェーズ。FindingsGraph全体を **人が読むレポート + 機械処理用JSON** に変換する。

- `type`: breadth(終端, 特別扱い)
- `consumes`: グラフ全体
- `produces`: `Report`(成果物)
- 出力先: `report/report.md` と `report/report.json`

## 8.1 二段構成(決定的生成 + AI要約)

| 段 | 担当 | 内容 |
|----|------|------|
| 8.2 決定的生成 | kyumei(report/*.ts) | グラフから機械的に統計・一覧・系譜を生成(再現可能・捏造不可) |
| 8.3 AI要約 | Cascade | 決定的セクションを入力に「エグゼクティブサマリ」「注目所見」「推奨」を生成 |

**重要**: 事実(エンティティ・数値・証拠)は決定的生成が担い、AIは**その上の解釈と要約だけ**。AIに事実を作らせない(反ハルシネーション)。

## 8.2 決定的生成(report/markdown.ts, json.ts)

### 生成関数
```ts
function buildJsonReport(graph, run): ReportJSON
function buildMarkdownReport(graph, run, aiSummary?): string
```

### Markdownレポートの構成(セクション=1機能)
1. **Run概要**: target, runId, 期間, 実行Task数, コマンド数, 予算消費, 収束理由。
2. **フットプリント統計**: カテゴリ別件数、status分布(live/dead/abandoned…)、時間軸分布(現役 vs 歴史的)。
3. **資産インベントリ(全件表)**: type / value / status / interest / 主要attrs / 証拠リンク。
   - **abandoned/dead/deprecated を上部にソート**(見落とし資産を目立たせる)。
4. **注目所見(High-interest)**: interest 上位 + 確認済み仮説(confirmed)。各々に証拠パス。
5. **調査の方向(Triageの記録)**: 「何を・なぜ深掘ったか」一覧(05の根拠)。
6. **発見の系譜(reflux)**: `derived_from` を辿った木(例: APK → 内部ドメイン → 新サービス)。
7. **仮説台帳**: open / confirmed / refuted の一覧と結論。
8. **未探索フロンティア**: 予算で打ち切った残Task(次回の入口)。
9. **付録: 証拠インデックス**: operationId → コマンド → evidenceファイル の対応表。

### JSONレポート(report.json)
- `graph`(エンティティ+エッジ, provenance付き)、`stats`、`triage`、`hypotheses`、`frontierPending`、`evidenceIndex`。
- 機械処理・可視化(グラフ描画)・差分比較(前回run比)に使う。

## 8.3 AI要約ステップ

PhaseRuntime(04)経由で Cascade を1回呼ぶ:
- 入力: 8.2 で生成した Markdown の事実セクション(2〜7)。
- 指示: 「エグゼクティブサマリ(5行)、最も注目すべき所見Top5(なぜ重要か)、次に取るべき調査の推奨」を生成。
- 制約: **新しい事実・数値・エンティティを作らない**。既出の証拠付き事実のみ参照。出力に証拠パスを引用させる。
- 出力は `report/summary.md` に保存し、Markdownレポート冒頭に差し込む。

## 8.4 status / interest を活かした提示

- **見落とし狙いの可視化**: `abandoned`/`dead` 資産を専用セクション「忘れられた資産(Forgotten Assets)」でまとめる。
- interest スコアのヒートマップ的一覧(数値高→注意喚起)。
- 時間軸: 「過去にのみ存在(Historical-only)」の資産を別掲(Waybackのみ等)。

## 8.5 部分結果・中断時

- ABORTED(予算超過/中断)でも実行。レポート冒頭に **「部分結果」明示** + 未探索フロンティア(8番)を強調。
- これにより「途中で止めても成果が残る」。

## 8.6 出力の確定処理

```ts
function finalize(run) {
  snapshotGraph(run.id, graph);             // graph.json 確定
  writeFile("report/report.json", json);
  writeFile("report/report.md", md);
  copyEvidenceIndex();                       // 証拠インデックスを report/ にも複製
  audit("synthesis_done", { reportPaths });
}
```

## 8.7 再現性・差分

- レポートは graph.json から**いつでも再生成可能**(`kyumei report <runId>`)。
- 2つの run の report.json を比較し、**前回から増えた資産/状態変化** を出す差分機能の素地(将来)。
