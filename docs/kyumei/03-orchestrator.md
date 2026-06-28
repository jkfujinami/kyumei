# 03. Orchestrator — Frontier と探索制御

フェーズ駆動の本体。**Frontier(作業キュー)をグラフ探索的に回し**、breadthとdeepeningを往復させ、収束まで進める。

## 3.1 Task と Frontier

```ts
interface Task {
  id: string;
  phaseId: string;          // 実行するフェーズ
  seedId: string;           // 入力エンティティ(Targetの場合は特別ID)
  depth: number;            // refluxホップ数(0=起点)
  priority: number;         // Triageが付与(降順でpop)
  reason?: string;          // なぜこのTaskが積まれたか(監査・レポート)
  createdBy?: string;       // 親TaskのID(系譜)
}
```

### Frontier(優先度付きキュー)
```ts
class Frontier {
  push(task: Task): void          // dedupKey で重複排除しつつ挿入(3.4)
  pop(): Task | undefined         // priority降順、同点はdepth昇順(浅いもの優先=広さ優先)
  size(): number
  pending(): Task[]               // 監査・再開用スナップショット
}
```
- **pop順の方針**: `priority` 高い順 → 同点なら `depth` 浅い順。これにより「浅く広く」を先に消化し、深掘りはTriageが選んだ高優先のものから。

## 3.2 メインループ

```ts
async function run(ctx: RunContext) {
  frontier.push(bootstrapTask());           // {Footprint, Target, depth0, priority:1.0}

  while (!frontier.empty() && budget.ok()) {
    // (a) breadth を一巡優先消化 → (b) たまった所で Triage → (c) deepening投入
    const task = frontier.pop();
    if (graph.isExplored(task.phaseId, task.seedId)) continue;

    const outcome = await PhaseRuntime.run(task, ctx);     // 04
    graph.merge(outcome.findings);                         // 01
    graph.markExplored(task.phaseId, task.seedId);

    enqueueFollowups(outcome, task);                       // 3.3
    maybeTriage(ctx);                                      // 3.5
  }

  await PhaseRuntime.run(synthesisTask(), ctx);            // 08
}
```

## 3.3 フォローアップ生成(consumes照合=自動配線)

```ts
function enqueueFollowups(outcome, parent: Task) {
  for (const entity of outcome.newEntities) {
    entity.firstSeenDepth = parent.depth + 1;
    for (const phase of phasesConsuming(entity.type)) {     // phase.consumes に entity.type が含まれるか
      if (parent.depth + 1 > maxDepthFor(phase)) continue;  // 深さ上限(3.6)
      if (graph.isExplored(phase.id, entity.id)) continue;
      frontier.push({
        phaseId: phase.id, seedId: entity.id,
        depth: parent.depth + 1,
        priority: defaultPriority(phase, entity),           // breadthは高め初期値
        reason: `produced ${entity.type} from ${parent.phaseId}`,
        createdBy: parent.id,
      });
    }
  }
}
```
- **新ドメイン → Footprint(breadth)に自動で戻る**=還流(reflux)がここで起きる。
- **新Artifact → AssetAnalysis(deepening)** など、型で行き先が決まる。

## 3.4 重複排除(dedup)

- **Task単位**: `dedupKey = phaseId + ":" + seedId`。同一キーは Frontier・実行済みの双方でブロック。
- **Entity単位**: `graph.upsertEntity` の正規化キー(01.8)で同一物をmerge。
- これにより「同じドメインを何度も全列挙する」「同じAPKを何度も解析する」を防ぐ。

## 3.5 Triage連携(方向決定の差し込み)

`maybeTriage` の発火条件(いずれか):
- breadthタスクが一定数完了して deepening候補が溜まった。
- Frontierが breadthを出し切り deepeningだけになった直前。
- 一定間隔(Nタスクごと)。

発火すると Triage(05)がグラフを見て deepening候補の `priority` を再計算し、Frontierを並べ替える。**「広く集める→何を深掘るか決める」のリズムをここで作る**。

## 3.6 深さ・幅の制御

| 制御 | 既定 | 説明 |
|------|------|------|
| `maxDepth` (全体) | 4 | refluxホップ上限。これを超える seed はキューしない |
| `maxDepthFor(phase)` | phase別上書き可 | 例: Footprintは深くてもOK、AssetAnalysisは浅めに |
| `maxBreadthPerSeed` | 例:なし | 1 seed から生む子の上限(暴走抑制。任意) |
| `maxTasks` | config | Run全体のTask総数上限 |

## 3.7 収束判定(Convergence)

ループ終了は次のいずれか(`budget.ok()` と while条件で表現):
1. **Frontier空**: 新規Taskが尽きた(自然収束)。
2. **予算超過**: `maxTasks` / 時間 / コスト 上限(09)。
3. **新規発見ゼロが継続**: 直近Nタスクで新エンティティが出ない(stagnation検知)→ 早期終了。

いずれの場合も Synthesis は必ず実行(部分結果でもレポート化)。

## 3.8 RunContext(全層共有の実行文脈)

```ts
interface RunContext {
  runId: string;
  workspacePath: string;
  config: KyumeiConfig;        // 10
  graph: FindingsGraph;        // 01
  frontier: Frontier;
  agent: CascadeAgent;         // 02
  budget: Budget;              // 09
  audit: AuditSink;            // 09
  phases: Map<string, Phase>;  // 登録済みフェーズ
}
```

## 3.9 再開可能性(resume)

- 各Task完了後に `run.json`(Frontier pending + 進捗)と `graph.json` をスナップショット。
- `kyumei resume <runId>` で graph と frontier を復元し、`markExplored` 済みをスキップして継続(02のresumeCascadeと連動)。
- 監査ログとスナップショットがあるため**途中失敗しても無駄にならない**。

## 3.10 状態遷移(Orchestrator視点)

```
push(bootstrap) → [loop: pop → runPhase → merge → enqueue → maybeTriage] → synthesis
                       ↑__________ reflux(新Domain等が再投入) __________|
```
