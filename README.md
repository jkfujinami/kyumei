# kyumei

AI支援型インフラ調査ツールの **PoC**。
**AI(Antigravity/Cascade)＝司令官、CLIツール群＝手下、kyumei＝参謀** という構図で、
指定対象の「組織が外に出した全資産(現役+過去/廃止/忘却)」を浅く広く収集し、各資産をAIが深掘りし、
発見を還流(reflux)させながら調査を深めていく。

設計の詳細は [`docs/`](./docs/) と [`docs/kyumei/`](./docs/kyumei/) を参照。

## 仕組み(PoC実装)

```
footprint(浅く広く) → 新資産 → assetAnalysis(深掘り) → 新ドメイン
      ↑__________________ reflux(還流) __________________|
                          → synthesis → report
```

- **AIが司令官**: Web検索・推論で対象資産を発見し、曖昧情報をCLI入力に翻訳して手下(CLI)を実行、結果を解釈(`docs/kyumei/11-tool-arsenal.md`)。
- **見落とし狙い**: `dead`/`abandoned`/`deprecated` 資産を高スコア化してレポート上位に。
- **反ハルシネーション**: 全 finding に証拠ファイルパス(`evidence/`)を紐付け。
- **AIの実行基盤**: [antigravity-client](https://github.com/jkfujinami/antigravity-client)(Cascade)。MCPは使わず、素のシェル+CLI+Web検索をAIに渡す。

## セットアップ

```bash
npm install            # antigravity-client(ネイティブビルド含む)+ devDeps
# 本番runには Antigravity 本体の導入・ログインが必要
```

## 使い方

```bash
# 配管検証(LLM不要・Antigravity接続なし。ループ/reflux/レポートを確認)
npm run kyumei -- run example.com --mock

# AI+CLI実結線の安全テスト(外部を一切叩かず、接続〜コマンド承認〜findings書込を検証)
npm run kyumei -- smoke

# 本番(Antigravity経由でAIが自律調査。許可された対象でのみ)
npm run kyumei -- run <target>

# オプション
#   --model <id>      使用モデル名 or 数値ID (default: 1018)
#   --max-depth <n>   reflux深さ上限 (default: 2)
#   --max-tasks <n>   Task総数上限 (default: 12)
#   --top-k <n>       深掘り優先実行数 (default: 3)
```

> テスト環境が無くても、**`--mock`(ロジック)** と **`smoke`(AI+CLI実結線)** で大半を検証できる。
> 実OSINTの練習は、自分が所有するドメインか、明示的に許可された公開対象(例 `scanme.nmap.org`)で。

成果物は `.kyumei/runs/<runId>/` に出力:
`findings.jsonl`(AIの構造化発見) / `evidence/`(証拠) / `artifacts/`(取得物) / `report/report.md` / `audit.log`。

## ⚠️ 利用上の注意

本ツールは **自己資産・検証環境・明示的に許可されたPoC対象** に対してのみ使用すること。
PoC段階では scope 制限・サンドボックスは未実装(設計上の継ぎ目のみ用意、`docs/kyumei/09-safety-and-exec.md`)。

## 構成

| パス | 役割 |
|------|------|
| `src/index.ts` | CLIエントリ |
| `src/orchestrator.ts` | Frontier探索・reflux制御 |
| `src/agent.ts` | `AntigravityAgent`(本番)/ `MockAgent`(検証) |
| `src/phases.ts` | フェーズのプロンプト(footprint/assetAnalysis/synthesis) |
| `src/findings.ts` | FindingsGraph・JSONL読取・スコアリング |
| `src/report.ts` | Markdown/JSONレポート生成 |
| `src/workspace.ts` | run作業ディレクトリ・監査ログ |
