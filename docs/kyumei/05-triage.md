# 05. Triage — 方向決定(何を深掘るか)

「浅く広く集めた」結果から **深掘り対象を選び、順番を決める**工程。kyumeiの「調査の方向性を自動決定」の意思決定点。**広さは機械が保証(03のfollowup)、深掘りの優先順位はここ(AI+ルール)で決める**。

## 5.1 二層の方向決定

| 層 | 担当 | 役割 |
|----|------|------|
| 決定的層 | Orchestrator(03) | 新エンティティに該当breadthフェーズを必ずキュー(漏れ防止) |
| 意味的層 | **Triage(本章)** | deepening候補(Asset)を根拠付きでランク付け→priority更新 |

## 5.2 スコアリング(ルールベース下地)

各候補エンティティに **基礎スコア** を機械的に付与(0..1)。Triageのプロンプトにもこの内訳を渡す。

```ts
function baseScore(e: Entity): number {
  let s = 0;
  // status: 見落とし狙いの核(doc04)
  s += ({ abandoned:0.9, dead:0.6, deprecated:0.7, unknown:0.4, live:0.3 })[e.status];
  // tags
  if (e.tags.includes("internal")) s += 0.3;
  if (e.tags.includes("staging"))  s += 0.3;
  if (e.tags.includes("forgotten"))s += 0.2;
  // type: 解析の入口になりやすいもの
  if (e.type === "Artifact" || e.type === "MobileApp") s += 0.2;
  if (e.type === "Api") s += 0.15;
  // 新規性: 深い還流で出たもの(=人目に触れにくい)
  s += Math.min(e.firstSeenDepth * 0.05, 0.2);
  // 既存証拠の強さ
  if (e.provenance.some(p => p.evidencePath)) s += 0.05;
  return clamp01(s);
}
```

**設計意図**: `abandoned`/`internal`/`staging`/`deprecated` を強く持ち上げる=「誰も見てない放置資産」を優先。参考事例の「staging→prod」「内部API」が高価値だった経験則の反映。

## 5.3 AIによる再ランク(意味的判断)

Triageは軽量フェーズとして Cascade を一度呼ぶ(または安価モデルで)。

入力(プロンプト):
- 候補リスト(エンティティ + baseScore + 主要attrs + 近傍関係の要約)。
- 指示: 「各候補に **深掘り価値** を 0..1 で付け、**根拠(なぜ調べる価値があるか)** と **狙う方向(何を確かめるか)** を1行で述べよ」。
- 出力契約: `findings.jsonl` に `hypothesis` 風レコードで書く(targetValue + statement + rationale + score)。

```jsonc
{ "kind":"triage", "targetValue":"staging.acme.com", "score":0.85,
  "rationale":"staging命名だが解決し本番DB疑い", "direction":"認証バイパス・本番データ露出を確認" }
```

最終 `priority = w1*baseScore + w2*aiScore`(既定 w1=0.4, w2=0.6)。AIの判断を主、ルールを下支えに。

## 5.4 Frontierへの反映

```ts
function applyTriage(results: TriageResult[], ctx) {
  for (const r of results) {
    const e = ctx.graph.resolveByValue(r.targetValue);
    e.interest = r.priority;                         // グラフにも保存(レポート/再Triage用)
    // 既存の deepening Task があれば priority 更新、無ければ生成
    ctx.frontier.upsertPriority(deepeningTaskFor(e), r.priority, r.direction);
    // 仮説をエンティティ化(01: Hypothesis)し、direction を AssetAnalysis に引き継ぐ
    ctx.graph.upsertEntity({ type:"Hypothesis", value:r.statement,
      attrs:{ targetEntityId:e.id, direction:r.direction, status:"open" }});
  }
}
```

- `direction`(狙う方向)は **AssetAnalysis(07)の buildContext に渡され**、深掘りの初期方針になる。Triage=「次の一手のお題出し」。

## 5.5 発火タイミング(03と連動)

- breadthが一定量たまった時 / breadth枯渇直前 / Nタスク毎(03.5)。
- **過剰発火を避ける**: 前回Triage以降に新規Assetが増えていなければスキップ。

## 5.6 予算配分(深掘りの幅を絞る)

- Triage後、Frontierの deepening上位 `K` 件だけを「今サイクルで実行可」とマーク(`K`=config)。
- 残りは保持され、次のTriageで再評価(新情報で順位が変わりうる)。
- これで「全資産を無制限に深掘り」せず、**価値の高い方向に予算を集中**。

## 5.7 出力・監査

- 各Triage判断(候補・baseScore・aiScore・最終priority・rationale・direction)を `audit.log` と graph に記録。
- レポート(08)に **「なぜこの順で深掘ったか」** の根拠として掲載=調査の透明性。
