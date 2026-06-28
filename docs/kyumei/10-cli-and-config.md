# 10. CLI & Config & ライフサイクル

エントリポイント・設定・run の起動から終了までの配線。

## 10.1 CLI(src/index.ts)

```
kyumei run <target> [options]      新規調査を開始
kyumei resume <runId>              中断/失敗したrunを継続(03.9)
kyumei report <runId>              graph.jsonからレポート再生成(08.7)
kyumei list                        過去runの一覧(.kyumei/runs/)
kyumei show <runId>                run概要・進捗・収束理由
```

### run の主なオプション
| オプション | 既定 | 説明 |
|-----------|------|------|
| `--target <domain|org>` | (必須) | 調査起点 |
| `--model <id>` | Gemini_3_Flash | 既定モデル(フェーズ別上書きは設定で) |
| `--max-depth <n>` | 4 | reflux深さ上限(03.6) |
| `--max-tasks <n>` | 200 | Task総数上限(09.3) |
| `--budget-minutes <n>` | 60 | 実時間上限 |
| `--triage-top-k <n>` | 8 | 1サイクルで実行する深掘り上位数(05.6) |
| `--phases <list>` | all | 実行フェーズの限定(例: footprintのみ) |
| `--workspace <dir>` | .kyumei/runs/ | run workspace親dir |
| `--verbose` | false | Cascade/イベント詳細表示 |
| `--dry-run` | false | 接続・workspace生成まで(実行しない) |

## 10.2 Config(src/config.ts)

CLIオプション < 設定ファイル < 既定 のマージ。設定ファイル `kyumei.config.{ts,json}`:

```ts
interface KyumeiConfig {
  defaultModel: string;
  models?: { footprint?:string; assetAnalysis?:string; triage?:string; synthesis?:string };
  limits: { maxDepth:number; maxTasks:number; maxCommands:number;
            wallClockMs:number; bytesDownloaded:number; perCommandTimeoutMs:number };
  triage: { topK:number; weights:{ base:number; ai:number } };   // 05.3
  phases: { enabled:string[] };
  tools?: { ensure?:string[] };          // 起動時に存在確認/導入したいCLI(10.4)
  approval?: { extraDenyPatterns?:string[] };   // 09.4 追加deny
  // scope は将来追加(09.6)。現状フィールドなし。
}
```

フェーズ別モデル例(設計意図): Footprint=Flash(速・網羅)、AssetAnalysis=Pro(賢・仮説)、Triage=Flash、Synthesis=Pro。

## 10.3 起動ライフサイクル(`kyumei run`)

```
1. parseArgs → loadConfig(マージ)
2. runId採番(時刻+target hash)、workspace生成(0.3の構成)
3. PLAYBOOK枠・findings.jsonl(空)・evidence/ artifacts/ 作成
4. CascadeAgent.connect({ workspacePath, model, approval, audit })  (02)
5. ensureTools(config.tools.ensure)  ← 10.4(任意)
6. graph = new FindingsGraph(); graph.setTarget(target)
7. frontier.push(bootstrapTask)  → Orchestrator.run(ctx)  (03)
8. ループ終了 → Synthesis(08) → finalize
9. CascadeAgent.dispose() → 終了コード/レポートパス表示
```

## 10.4 ツール存在確認(ensureTools)

- `config.tools.ensure`(例 `["subfinder","httpx","tlsx","jadx","apktool","gitleaks"]`)について、起動時に存在確認。
- **不在でも失敗にしない**: 「無い」ことを監査/レポートに記録し、Cascadeのプロンプトに「未導入。必要なら自分で導入してよい」と伝える(CLIエージェント方針=AIが自律導入)。
- これにより「環境に何が揃ってるか」を前提にせず、AIの自律導入能力を活かす。

## 10.5 RunContext 構築

10.3 の各オブジェクト(graph/frontier/agent/budget/audit/config/phases)を `RunContext`(03.8)に束ね、全層へ渡す。フェーズ登録:
```ts
phases.set("footprint", FootprintPhase);       // 06
phases.set("assetAnalysis", AssetAnalysisPhase);// 07
phases.set("synthesis", SynthesisPhase);       // 08
// Triageはフェーズではなくループ内ステップ(05)
```

## 10.6 終了コードと出力

| 終了 | コード | 表示 |
|------|--------|------|
| 正常収束 | 0 | レポートパス、統計、forgotten資産数 |
| 予算/中断で部分完了 | 0(警告) | 部分結果である旨 + 未探索フロンティア |
| 接続失敗(Antigravity未導入等) | 2 | 前提環境エラー |
| 致命的エラー | 1 | スタック + 監査ログパス |

## 10.7 最小実装の到達順(再掲・実装ガイド)

1. config + CLI 骨格(本章)+ workspace生成。
2. CascadeAgent.connect/run + exec層(素通し)+ audit(02/09)。
3. FindingsGraph + store(01)。
4. PhaseRuntime(04)+ Footprint(06)を最小実装 → 単体で「1ドメインを浅く広く」動作確認。
5. Orchestrator + Frontier + followup(03)→ reflux が回る。
6. AssetAnalysis(07)+ Triage(05)→ 深掘りが回る。
7. Synthesis(08)→ レポート出力。
8. 以降: APK取得・解析の充実、フェーズ別モデル、(将来)scope/sandbox middleware。
