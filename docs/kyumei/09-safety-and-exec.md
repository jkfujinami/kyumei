# 09. Safety & Exec — exec層・監査・予算

横断的な実行基盤。**コマンド実行の唯一の経路(exec層)**、監査、予算/レート、そして将来の scope/sandbox を挿すための継ぎ目を定義する。

> 方針(現状): scope **なし**(全許可)・サンドボックス **なし**(素のPCシェル)。本章は「今は薄く、後で挿せる」設計にする。

## 9.1 exec層(agent/exec.ts)

CascadeのRunCommandは**必ずここを通る**(02.6)。今は素通し+監査だが、**唯一の差し込み点**として設計。

```ts
interface ExecRequest { command: string; cwd: string; runId: string; }
interface ExecResult { operationId: string; exitCode: number; stdoutPath: string;
                       stderrPath?: string; durationMs: number; timedOut: boolean; }

interface ExecMiddleware {                  // ★継ぎ目: 配列で挟む
  name: string;
  before?(req: ExecRequest): MiddlewareVerdict | Promise<MiddlewareVerdict>;
  after?(req: ExecRequest, res: ExecResult): void | Promise<void>;
}
type MiddlewareVerdict = { action:"allow"|"deny"|"rewrite"; reason?:string; command?:string };

async function exec(req: ExecRequest, mws: ExecMiddleware[]): Promise<ExecResult>;
// before を順に評価 → deny で中断(理由をCascadeへ) → allow なら実行
// → operationId採番 → 出力を evidence/ 保存 → after(監査等) → 結果返却
```

### 現状の middleware スタック
1. `approvalMiddleware`(02.6): 破壊的コマンドを deny、他は allow。
2. `budgetMiddleware`(9.3): 上限超過なら deny。
3. `auditMiddleware`(9.2): before/after を記録。

### 将来挿す middleware(継ぎ目だけ用意)
- `scopeMiddleware`: コマンドから対象ホスト/URLを抽出し、scope allowlist 外なら deny/rewrite。**ここを足すだけでscope対応**。
- `sandboxMiddleware`: cwd/ネットワークを隔離環境にリライト。
- `rateLimitMiddleware`: ホスト単位のレート制御。

> **設計の肝**: scope/sandbox を「後付け」にできるのは、実行が exec() の1点に集約されているから。コード本体は触らず middleware を追加するだけで効く。

## 9.2 監査(safety/audit.ts)

```ts
interface AuditSink { write(event: AuditEvent): void; }
type AuditEvent =
  | { t:"command"; operationId; command; cwd; verdict; ts }
  | { t:"command_result"; operationId; exitCode; durationMs; timedOut; ts }
  | { t:"phase_start"|"phase_end"; phaseId; seedId; ts; stats? }
  | { t:"triage"; candidates; ts }
  | { t:"finding_verified"|"finding_unverified"; ref; ts }
  | { t:"budget"; metric; value; limit; ts }
  | { t:"state"; state; ts };
```
- 出力: `audit.log`(1行1JSON, 追記専用)。
- **全コマンド・全フェーズ遷移・全Triage判断**を記録 → 再現性=反ハルシネーション(主張を実行ログに突合できる)。
- レポート(08)の「証拠インデックス」「方向の記録」はここから生成。

## 9.3 予算・レート(safety/budget.ts)

```ts
interface Budget {
  ok(): boolean;                  // 全上限内か(Orchestratorのwhile条件)
  charge(metric, n): void;        // 消費を加算
  remaining(metric): number;
  snapshot(): BudgetState;
}
type BudgetMetric = "tasks" | "commands" | "wallClockMs" | "llmCallsApprox" | "bytesDownloaded";
```
| metric | 既定上限(config) | 効果 |
|--------|------------------|------|
| tasks | 例 200 | Task総数(03収束条件) |
| commands | 例 2000 | 総コマンド数 |
| wallClockMs | 例 60分 | 実時間 |
| llmCallsApprox | 任意 | コスト目安 |
| bytesDownloaded | 例 2GB | 取得物の総量(APK等の暴走防止) |

- 超過時: `ok()` が false → ループ終了 → Synthesis(部分結果)。
- per-command タイムアウトも budget config 管轄(02.8)。

## 9.4 操作の安全分類(現状の最低限ガード)

PoCで素のシェルを渡すが、**明確に有害なものだけ**は exec の approval で止める:
- システム破壊: `rm -rf /`, ディスク/パーティション操作, `:(){:|:&};:` 等。
- 認証情報の外部送信痕跡 / 大量送信。
- これ以外(調査CLI・取得・解析・検索・ツール導入)は許可。

> 能動的攻撃(実際の侵入・改ざん・DoS)は kyumei の目的外。Asset Analysis(07)は **OSINT/取得/解析と到達性確認まで**。秘密は痕跡記録に留め悪用しない。

## 9.5 成果物の取り扱い(sandboxなしでの最低限)

- 取得物は `artifacts/` に隔離保存し `sha256` 記録。
- 逆コンパイル等は run workspace 内で実行(将来 sandboxMiddleware でコンテナ化できる継ぎ目)。
- 取得元URL・ハッシュを監査に残す(出所追跡)。

## 9.6 将来のscope導入手順(設計予約)

実装フェーズで scope を足すときの最小手順(本設計が保証する拡張点):
1. `config` に `scope: { domains:[], ipRanges:[], includeSubdomains:bool }` を追加。
2. `scopeMiddleware` を実装(コマンド/URLからホスト抽出→allowlist照合)。
3. exec の middleware スタックに1行追加。
4. Triage/Footprint の prompt に「scope外は対象外」を追記。
→ **本体ロジック(Orchestrator/Phase/Graph)は無改修**。
