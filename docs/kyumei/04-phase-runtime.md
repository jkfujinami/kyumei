# 04. PhaseRuntime — 単一フェーズの実行ループ

1つの Task(= phase × seed)を Cascade で実行し、検証済み findings を返す。**「お題を作る→走らせる→完了を判定→回収→検証」**の5工程。全フェーズで共通。

## 4.1 Phase インターフェース(phases/Phase.ts)

```ts
interface Phase {
  id: string;
  type: "breadth" | "deepening";
  goal: string;
  consumes: EntityType[];                 // 03のfollowup配線が参照
  produces: EntityType[];
  suggestedTools: string[];               // promptに埋めるヒント
  maxDepth?: number;
  model?: string;                         // フェーズ別モデル上書き(02)
  timeoutMs?: number;

  buildSystemPrompt(): string;            // 静的な手法・ルール・出力契約(prompts/配下)
  buildContext(seed: Entity, graph: FindingsGraph): string;  // 動的な文脈
  exit: ExitSpec;                         // 完了判定仕様(4.5)
  expectedActions?(seed): ExpectedAction[];  // 決定的網羅チェック用(4.5)
}
```

## 4.2 実行関数(全体像)

```ts
async function run(task: Task, ctx: RunContext): Promise<PhaseOutcome> {
  const phase = ctx.phases.get(task.phaseId)!;
  const seed  = resolveSeed(task, ctx.graph);

  const prompt = composePrompt(phase, seed, ctx);     // 4.3
  const startOffset = store.currentOffset(ctx.runId); // findings.jsonl の現在位置

  const outcome = await ctx.agent.run(prompt, {        // 02
    timeoutMs: phase.timeoutMs, model: phase.model,
  });

  let delta = store.readFindingsDelta(ctx.runId, startOffset);  // このフェーズの増分のみ

  const exitResult = evaluateExit(phase, seed, outcome, delta, ctx);  // 4.5
  if (exitResult.action === "reprompt") {
    await ctx.agent.run(exitResult.followupPrompt);    // 不足を埋めさせる(最大N回)
    delta = store.readFindingsDelta(ctx.runId, startOffset);
  }

  const verified = verifyEvidence(delta, ctx);         // 4.6
  const merged   = normalizeToEntities(verified, seed, task, ctx);  // 4.7
  return { findings: merged.records, newEntities: merged.entities, exit: exitResult };
}
```

## 4.3 プロンプト合成(composePrompt)

3部構成。**静的(手法)+ 動的(文脈)+ 契約(出力形式)**。

```
[A] System/手法ブロック ← phase.buildSystemPrompt()
    ・このフェーズの目的とルール
    ・「報告する/しない」の境界(noise-first, doc02 G)
    ・suggestedTools(使えるCLI例。足りなければ自分で入れて良い旨)
    ・status判定の指針(live/dead/abandoned)

[B] コンテキストブロック ← phase.buildContext(seed, graph)
    ・今回の seed(対象資産)とその既知属性
    ・グラフ上の関連finding(親・近傍ノード=引き継ぎ。doc02 F-2)
    ・既出で「やらなくてよいこと」(重複抑制)

[C] 出力契約ブロック(全フェーズ共通テンプレ)
    ・「発見は findings.jsonl に1行1JSONで追記」(01.5の形式)
    ・「各findingに evidencePath を必須。証拠は evidence/ に残せ」
    ・「完了したら {"kind":"phase_complete", "covered":[...]} を書け」
    ・workspace構成(evidence/ artifacts/ の使い方)
```

`PLAYBOOK.md` に [A][C] を書き出し Cascade に常時見せ、[B] は run プロンプト本文に入れる(長文文脈の参照分離)。

## 4.4 seed の解決

```ts
function resolveSeed(task, graph): Entity {
  if (task.seedId === TARGET_SENTINEL) return graph.getTarget();
  return graph.getEntity(task.seedId)!;
}
```
deepeningでは seed は単一資産。breadth(Footprint)では seed が Target/Domain/Org のいずれか。

## 4.5 完了判定(ExitSpec)

3手段を併用(doc04方針)。

```ts
interface ExitSpec {
  requireSignal: boolean;       // phase_complete 行を要求するか(既定true)
  exhaustiveness?: boolean;     // expectedActions の充足を確認するか
  maxReprompts: number;         // 不足時の追いプロンプト上限(既定2)
}

type ExitResult =
  | { action:"complete" }
  | { action:"reprompt"; followupPrompt:string; missing:string[] }
  | { action:"forced"; reason:"timeout"|"budget"|"max_reprompts" };
```

`evaluateExit` の判定:
1. **AIシグナル**: delta に `phase_complete` があるか。
2. **決定的網羅チェック**: `phase.expectedActions(seed)` の各項目が監査ログ(実行コマンド)or delta で満たされているか。
   - 例(Footprint/Domain seed): 「CT列挙」「passive DNS」「httpx生存確認」「wayback参照」のコマンド痕跡が監査にあるか。
   - 欠けていれば `reprompt`(「以下が未実施: wayback。実施して findings に反映せよ」)。
3. **キャップ**: timeout / budget / reprompt上限 → `forced`(部分結果を採用)。

> これが「早期離脱」(AIが数手で完了宣言)を防ぐ仕掛け。**網羅は機械が確認し、足りなければ追いプロンプトで埋めさせる**。

## 4.6 証拠検証(verifyEvidence)— 反ハルシネーション

```ts
function verifyEvidence(delta, ctx): VerifiedFinding[] {
  for (const rec of delta) {
    if (rec.kind === "phase_complete") continue;
    const p = rec.evidencePath;
    if (!p || !existsInWorkspace(ctx, p)) {
      rec._tags = [...(rec._tags||[]), "unverified"];   // 破棄ではなく降格
      rec._confidencePenalty = 0.5;
    } else {
      // 任意: 証拠ファイル内に主張のキーワード(値)が含まれるか軽くチェック
      if (!evidenceSupports(p, rec.value)) rec._tags.push("evidence_weak");
    }
  }
  return delta;
}
```
- **unverified は即破棄せず降格**(interest減点・レポート別枠)。完全排除すると有用情報を落とすため。ただしグラフの「確定」扱いはしない。

## 4.7 エンティティ正規化(normalizeToEntities)

- findings.jsonl の `entity`/`edge`/`hypothesis` レコードを **graph の upsert入力に変換**(01.7/01.8)。
- **IDはkyumeiが採番**(AIにIDを作らせない=捏造防止)。value→正規化キー→id。
- `provenance` を付与(phase, tool, operationId(evidencePathから逆引き), ts, confidence×penalty)。
- `derived_from` エッジを seed と新エンティティ間に張る(reflux系譜, 01.3)。
- 返り値の `newEntities` が 03 の followup を駆動する。

## 4.8 失敗・部分結果の扱い

| 事象 | 挙動 |
|------|------|
| run timeout | delta は回収、`forced` で完了扱い。網羅不足はTaskに `partial` フラグ |
| evidence全欠落 | findingは全部 unverified 降格。フェーズは「成果薄」記録、再キューはしない |
| Cascadeエラー | Taskを `failed` マーク。Orchestratorは継続(他Taskに影響させない) |
| reprompt上限 | `forced`、現状の検証済みfindingで前進 |

## 4.9 出力(PhaseOutcome)

```ts
interface PhaseOutcome {
  findings: VerifiedFinding[];     // 監査・レポート用の生記録
  newEntities: Entity[];          // 03 followup を駆動
  exit: ExitResult;
  stats: { commands:number; durationMs:number; tokensApprox?:number };
}
```
