# 00. アーキテクチャ全体像

## 0.1 一言定義

kyumei は **「フェーズ別のお題(systemプロンプト)と道具(CLI)をCascadeに渡し、自律調査を監視・回収・検証し、発見を次のお題に還流するオーケストレーター」**。実際に手を動かすのは Cascade、設計図と進行管理を持つのが kyumei。

## 0.2 コンポーネント関係図

```
┌──────────────────────────────────────────────────────────────────┐
│ CLI (10) ── run設定を読み、Runを開始                                │
└───────────────┬──────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Orchestrator (03)                                                  │
│   Frontier(作業キュー) を回す: pop → runPhase → merge → enqueue    │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐          │
│   │ Triage (05)  │   │ PhaseRuntime │   │ Convergence  │          │
│   │ 方向決定      │   │ (04) 単相実行 │   │ 収束判定      │          │
│   └──────────────┘   └──────┬───────┘   └──────────────┘          │
└──────────────────────────────┼────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Phase 定義 (06 Footprint / 07 AssetAnalysis / 08 Synthesis)        │
│   systemPrompt + consumes/produces + exit + suggestedTools         │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ CascadeAgent (02)  ── antigravity-client ラッパ                    │
│   run(prompt) / on(event) / exec層(09) で RunCommand を仲介・監査   │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼  (Cascadeが素のシェルで自律実行)
        ┌────────────┐   ┌────────────┐   ┌────────────┐
        │ CLI toolbox│   │ Web検索    │   │ File I/O   │
        └────────────┘   └────────────┘   └────────────┘
                               │
                               ▼ (findings.jsonl + 証拠ファイル)
┌──────────────────────────────────────────────────────────────────┐
│ FindingsGraph (01) ── エンティティ&エッジ&provenance を蓄積         │
│   → 新エンティティが Orchestrator の次タスクを生む(還流)           │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
                        Report (08) → docs/report/
```

横断: **Safety/Exec (09)**(exec仲介・監査・予算)と **Config (10)** は全層から参照される。

## 0.3 ディレクトリ構成(コードとworkspace)

### コード
```
src/
  index.ts                CLIエントリ → 10
  config.ts               設定ロード → 10
  orchestrator/
    Orchestrator.ts       → 03
    Frontier.ts           → 03
    Triage.ts             → 05
    PhaseRuntime.ts       → 04
  phases/
    Phase.ts              フェーズIF(共通型)
    footprint.ts          → 06
    assetAnalysis.ts      → 07
    synthesis.ts          → 08
    prompts/              フェーズ別systemプロンプト(.md or .ts)
  agent/
    CascadeAgent.ts       → 02
    exec.ts               exec層(継ぎ目)→ 09
    approval.ts           コマンド承認ポリシー → 02/09
  findings/
    Graph.ts              → 01
    types.ts              → 01
    store.ts              findings.jsonl 読み書き → 01
  safety/
    audit.ts              監査ログ → 09
    budget.ts             予算/レート → 09
  report/
    markdown.ts json.ts   → 08
```

### Run workspace(1 run = 1ディレクトリ)
```
.kyumei/runs/<runId>/
  run.json                run設定・状態のスナップショット
  PLAYBOOK.md             現フェーズの手法・ルール(Cascadeに見せる)
  findings.jsonl          AIが追記する構造化発見(追記専用ログ)
  graph.json              FindingsGraph の正規化スナップショット
  evidence/               コマンド出力・取得ファイル(証拠の実体)
    <operationId>.{txt,json,bin}
  artifacts/              取得した成果物(APK等)
  audit.log               全コマンド・全イベントの監査
  report/                 最終レポート(markdown + json)
```

## 0.4 中心データフロー(1サイクル)

```
1. Orchestrator が Frontier から Task{phase, seed, depth} を取り出す
2. PhaseRuntime が prompt を合成(phase.systemPrompt + seed文脈 + 出力契約)
3. CascadeAgent.run(prompt) → Cascade が自律実行
      ・コマンド実行は exec層を通り、監査・(将来)scope照合
      ・出力は evidence/ に保存、発見は findings.jsonl に追記
4. PhaseRuntime が exit条件を待ち、findings.jsonl の差分を回収
5. evidence検証(各findingに証拠パスがあるか)→ 不正は破棄
6. FindingsGraph に merge(新エンティティ・エッジ・status付与)
7. 新エンティティごとに、consumes照合で次Taskを生成
8. Triage が deepening候補をランク付けし、優先度付きで Frontier に投入
9. 収束(キュー空 or 予算/深さ上限 or 新規ゼロ)まで 1 に戻る
10. Synthesis フェーズ → report/ 出力
```

## 0.5 実行ライフサイクル(状態機械)

```
INIT ─→ BOOTSTRAP ─→ RUNNING ⇄ (PHASE_EXEC / TRIAGE) ─→ CONVERGED ─→ SYNTHESIS ─→ DONE
                                      │
                                      └─→ (予算超過/中断) ─→ ABORTED ─→ SYNTHESIS(部分) ─→ DONE
```
- **INIT**: config読込・runId採番・workspace生成。
- **BOOTSTRAP**: CascadeAgent 接続、最初のTask(Footprint, seed=Target, depth0)を投入。
- **RUNNING**: Frontierループ。PHASE_EXEC と TRIAGE を交互に。
- **CONVERGED/ABORTED**: ループ終了。いずれも Synthesis は走る(部分結果でもレポート化)。
- **DONE**: report出力・graph.json確定・後始末。

## 0.6 用語集

| 用語 | 意味 |
|------|------|
| Run | 1回の調査実行。固有の `runId` と workspace を持つ |
| Target | 調査の起点(ドメイン/組織名) |
| Phase | 目的+手法(systemプロンプト)+consumes/produces+exit のセット |
| breadth | 浅く広く網羅するフェーズ(Footprint Mapping) |
| deepening | 個別資産を深掘りするフェーズ(Asset Analysis) |
| Frontier | 未処理 Task の優先度付きキュー(調査の最前線) |
| Task | `{phase, seed, depth}` の実行単位 |
| seed | フェーズの入力となるエンティティ |
| Entity / Edge | FindingsGraph のノード/関係 |
| Asset | 調査対象プロダクト(ドメイン/サービス/API/アプリ等) |
| Finding | AIが報告した発見(証拠パス必須) |
| provenance | finding/エンティティの出所(phase, tool, operationId, ts, confidence) |
| status | 資産の生死(live/deprecated/dead/abandoned) |
| Triage | deepening候補をランク付けし方向を決める工程 |
| operationId | 1コマンド実行=1証拠の識別子(反ハルシネーションの核) |
| exec層 | コマンド実行の唯一の経路(監査・将来のscope/sandbox挿入点) |
| reflux(還流) | 深掘りの発見をbreadthに戻し再探索する循環 |
