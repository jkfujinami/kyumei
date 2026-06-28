# docs/kyumei — 機能詳細設計

kyumei(AI支援型インフラ調査ツール)の **1機能レベルの詳細設計**。各コンポーネント・各フェーズの全関数・全挙動をここに集約する。

> 上位の背景・方法論は親フォルダ `docs/` を参照:
> - [../01-case-study-deep-dive.md](../01-case-study-deep-dive.md) — 参考事例の徹底分析
> - [../02-abstracted-methodology.md](../02-abstracted-methodology.md) — 抽象メソドロジー(10パターン)
> - [../03-mapping-to-kyumei.md](../03-mapping-to-kyumei.md) — 抽象→kyumeiマッピング

## ファイル一覧(読む順)

| # | ファイル | 対象 |
|---|---------|------|
| 00 | [00-architecture.md](./00-architecture.md) | 全体像・コンポーネント関係・データフロー・実行ライフサイクル・用語 |
| 01 | [01-data-model.md](./01-data-model.md) | Findings Graph(エンティティ/エッジ/provenance/status)の完全仕様 |
| 02 | [02-cascade-agent.md](./02-cascade-agent.md) | antigravity-client統合・イベント処理・exec層・コマンド承認・監査 |
| 03 | [03-orchestrator.md](./03-orchestrator.md) | Frontierキュー・Task・depth・重複排除・収束・予算管理 |
| 04 | [04-phase-runtime.md](./04-phase-runtime.md) | 単一フェーズの実行ループ(prompt合成→run→exit判定→evidence検証) |
| 05 | [05-triage.md](./05-triage.md) | 方向決定(スコアリング・ランク付け・dead/abandoned優先) |
| 06 | [06-phase-footprint.md](./06-phase-footprint.md) | Footprint Mapping フェーズ(カテゴリ×時間の全collector) |
| 07 | [07-phase-asset-analysis.md](./07-phase-asset-analysis.md) | Asset Analysis フェーズ(理解→仮説→検証ループ) |
| 08 | [08-phase-synthesis.md](./08-phase-synthesis.md) | Synthesis/レポート生成フェーズ |
| 09 | [09-safety-and-exec.md](./09-safety-and-exec.md) | exec継ぎ目・監査ログ・予算/レート・将来のscope/sandbox挿入点 |
| 10 | [10-cli-and-config.md](./10-cli-and-config.md) | CLI・設定・runライフサイクル |
| 11 | [11-tool-arsenal.md](./11-tool-arsenal.md) | Tool Arsenal(武器庫)とAIディスパッチループ(知る→翻訳→振る→取り込む) |

## 設計の固定方針(全ファイル共通の前提)

1. **スタック**: TypeScript / Node.js (ESM)。
2. **AI頭脳**: antigravity-client の Cascade。**MCPは使わない**。AIには**CLIツール+シェル+ファイル操作+Web検索**を素で渡し、自律実行させる。
3. **環境**: PoCのため**素のPCシェル**。サンドボックスなし(将来挿入できる継ぎ目だけ残す)。
4. **scope**: 初期は**なし**(全許可)。ただし exec層に照合フックの継ぎ目を残す。
5. **役割分担(司令官・手下・参謀)**: **AI=司令官**(知る→翻訳→振る→取り込む。情報収集段階から意味判断・曖昧情報のツール入力への翻訳・解釈を担う)、**CLIツール群=手下**(武器庫=Tool Arsenal, doc11)、**kyumei=参謀**(広さ保証・実行監視・証拠検証・発見の還流)。詳細は [11-tool-arsenal.md](./11-tool-arsenal.md)。
6. **フェーズ二層構造**: `breadth`(浅く広く=Footprint Mapping)と `deepening`(深掘り=Asset Analysis)。両者を Frontier キューで往復させる。
7. **反ハルシネーション**: 全 finding は**証拠ファイルパス**を必須に紐付ける。
