# 02. CascadeAgent — antigravity-client 統合

Cascade(AIの頭脳)との唯一の接点。接続・プロンプト投入・イベント捕捉・コマンド仲介(exec層)・監査を担う。**kyumeiから見た「AI実行エンジン」のファサード**。

## 2.1 責務

1. antigravity-client への接続/起動と寿命管理。
2. フェーズの prompt を投入し、Cascadeの自律実行を回す。
3. Cascadeのイベント(`Text`/`RunCommand`/`Interaction`等)を捕捉。
4. `RunCommand` を **exec層(09)** に通し、承認・監査・(将来)scope照合を挟む。
5. 実行完了の検知(exit条件は04が判定、Agentは生イベントを供給)。

## 2.2 構成と型

```ts
interface CascadeAgentOptions {
  workspacePath: string;      // run workspace(0.3)
  model: string;              // 例 "Gemini_3_Flash" / "Gemini_3_Pro"
  verbose?: boolean;
  approval: ApprovalPolicy;   // コマンド承認(2.6)
  audit: AuditSink;           // 監査(09)
  onEvent?: (e: AgentEvent) => void;  // 観測用フック(PhaseRuntime/CLI表示)
}

type AgentEvent =
  | { kind:"text"; text:string }
  | { kind:"command"; operationId:string; command:string; cwd:string; decision:ApprovalDecision }
  | { kind:"command_result"; operationId:string; exitCode:number; stdoutPath:string; durationMs:number }
  | { kind:"interaction"; prompt:string }     // Cascadeが承認/入力を求めた
  | { kind:"idle" } | { kind:"error"; error:string };
```

## 2.3 ライフサイクル関数

```ts
class CascadeAgent {
  static async connect(opts): Promise<CascadeAgent>
  // antigravity-client の AntigravityClient.connect() / launch({workspacePath,verbose}) を内包。
  // LSバイナリ未検出時は launch にフォールバック。失敗時は明確なエラー(前提: Antigravity導入済み)。

  async startCascade(): Promise<void>
  // client.startCascade()。cascadeハンドルを保持し、on(...)で全イベント種を購読(2.5)。

  async dispose(): Promise<void>
  // ストリーム終了・接続クローズ。run workspace は保持(後でレポート/再開に使う)。
}
```

## 2.4 プロンプト実行

```ts
async run(prompt: string, opts?: { timeoutMs?: number }): Promise<RunOutcome>
// cascade.run(prompt, { model, timeoutMs }) を実行。
// 戻り: { text, completed, reason: "completed"|"timeout"|"aborted", events: AgentEvent[] }
// ・実行中の RunCommand はすべて exec層経由(2.6)。
// ・PhaseRuntime(04)は run の戻りと findings.jsonl 差分で exit を判定する。
```

`run` は **1フェーズ=複数の内部往復**を内包しうる(Cascadeが自律でコマンドを何度も打つ)。kyumeiは個々のコマンドを止めず、ポリシーに反するものだけ介入する。

## 2.5 イベント購読(マッピング)

antigravity-client のイベント → AgentEvent への変換:

| antigravity-client | AgentEvent | 処理 |
|--------------------|-----------|------|
| `Cascade.Events.Text` | `text` | バッファに蓄積(最終テキスト/進捗表示)|
| `Cascade.Events.RunCommand` | `command` | **exec層へ(2.6)**。承認・operationId採番・監査 |
| (コマンド完了) | `command_result` | stdout/stderrを evidence/<operationId> に保存、exitCode記録 |
| `Cascade.Events.Interaction` | `interaction` | 承認要求は approval ポリシーで自動応答(2.6) |

## 2.6 exec層連携とコマンド承認

`RunCommand` は必ず `agent/exec.ts`(09)を経由。フロー:

```
RunCommand(command, cwd)
  → operationId 採番 (op_NNN, run内連番)
  → approval.evaluate(command) → allow | deny | ask
       allow: 実行許可をCascadeへ返す
       deny : 拒否理由をCascadeへ返す(Cascadeは代替を試みる)
       ask  : (PoC初期は) 既定動作=allow。将来は対話確認の継ぎ目
  → 実行(Cascade側が実行)→ stdout/stderr/exitCode を取得
  → evidence/<operationId>.txt に保存(コマンド・cwd・結果を1ファイルに)
  → audit.log に追記(09)
  → operationId を Cascadeの文脈に残す(findingが参照する証拠ID)
```

### ApprovalPolicy(approval.ts)
```ts
interface ApprovalPolicy { evaluate(command: string): ApprovalDecision }
type ApprovalDecision = { action:"allow"|"deny"|"ask"; reason?: string };
```
- **初期実装(PoC)**: 既定 `allow`。ただし**明確に破壊的なパターン**(`rm -rf /`, ディスク全消去, fork bomb, 外部への大量送信痕跡など)は `deny`。
- **継ぎ目**: 将来ここに scope照合(対象外ホストへのアクセスコマンドを deny)を足す。**ポリシーは差し替え可能なインターフェース**にしておく。

## 2.7 operationId と証拠の規約

- 形式: `op_` + run内ゼロ詰め連番(`op_001`...)。
- 1コマンド実行 = 1 operationId = 1 evidenceファイル。
- findings.jsonl の `evidencePath` は必ず実在する evidence ファイルを指すこと(04で検証)。
- **これによりAIの主張は常に「実際に実行されたコマンドの出力」に紐づき、捏造できない**(元事例の operation_id 規約のCLI版)。

## 2.8 エラー・再試行・タイムアウト

| 事象 | 挙動 |
|------|------|
| 接続失敗 | 即エラー終了(前提環境の不備として明示) |
| run タイムアウト | `reason:"timeout"` で返す。PhaseRuntimeが部分結果を回収し、必要なら再プロンプト(04) |
| コマンドがハング | exec層の per-command タイムアウト(config)で打ち切り、`command_result` に timeout 記録 |
| Cascadeのストリーム切断 | 1回まで再接続→resumeCascade(id) を試行、ダメなら当該フェーズを失敗マーク |

## 2.9 設計上の注意

- CascadeAgent は **findings の意味を解釈しない**(それは04/01の責務)。生イベントと証拠保存に徹する=層の分離。
- model はフェーズごとに変えられる(Footprintは速いFlash、Asset Analysisは賢いPro等)。`run`呼び出し時にoptで上書き可能にする。
