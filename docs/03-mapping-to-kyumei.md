# 03. kyumei へのマッピング: 抽象メソドロジー → 実装設計

> [02-abstracted-methodology.md](./02-abstracted-methodology.md) の汎用フレームワークを、kyumei(TypeScript / Node.js / antigravity-client)の具体アーキテクチャに対応付ける。
>
> 注: 本ドキュメントは**設計の橋渡し**であり、実装はまだ着手していない。フェーズ構成・モジュール分割の合意形成が目的。

---

## 0. 前提の対応関係

| 元事例 | kyumei での対応 |
|--------|----------------|
| Claude + MCP(意味判断エンジン) | **antigravity-client / Cascade**(方針決定・分類・深掘り判断) |
| カスタムAPI Explorer(正規化) | **tools/ レイヤ**(統一されたツール実行 + 構造化応答) |
| probe_api / report / complete | **agent/policy + findings**(証拠ID付き構造化発見) |
| Google bugSWAT(許可枠組み) | **safety/scope allowlist**(自己資産・許可対象限定) |

kyumei は調査範囲を **OSINT中心 + 横断調査 + 成果物(APK等)取得・解析** に設定済み。元事例の Phase A/C/D/E がまさにこの領域に対応する。

---

## 1. 抽象フェーズ → kyumei フェーズの対応表

| 抽象 (doc 02) | kyumei フェーズ | 主担当レイヤ | AIの役割 |
|--------------|----------------|-------------|---------|
| A 資産ハーベスティング | **Phase 1: Scoping & Seed展開** + **Phase 3: Artifact取得** | tools/ (決定的) | 収集源の優先順位・追加シード提案 |
| B スコープ確定 | **safety/scope**(全フェーズ常駐) | safety/ (決定的) | なし(決定的判定) |
| C 表層列挙 | **Phase 2: 表層列挙** | tools/ (決定的) | 「次に何を列挙すべきか」の方針 |
| D プロトコル解明 | **Phase 4: Artifact解析**(APK→endpoint/SDK/host抽出) | tools/ + agent | 抽出結果の意味づけ・仮説生成 |
| E 正規化 | **tools/ 統一IF**(全ツールが構造化応答) | tools/ | なし(基盤) |
| F AI推論 | **orchestrator + agent/CascadeAgent** | agent/ (意味的) | 分類・深掘り・方向決定(中核) |
| G Signal/Noise | **agent/prompts/**(フェーズ別) | agent/ | ルールに従って判断 |
| 還流(再帰) | **orchestrator の pivot ループ** | orchestrator/ | 新シードの選別 |

---

## 2. モジュール構成(再掲 + 抽象パターン対応)

```
src/
  index.ts              CLIエントリ
  config.ts             スコープallowlist / 予算 / 深さ上限
  orchestrator/
    Orchestrator.ts     フェーズ実行 + pivot(還流)ループ      ← パターン#10
    Phase.ts            フェーズIF(systemPrompt + tools + 手法)
    phases/             scoping / surface / artifacts / analysis / synthesis
  agent/
    CascadeAgent.ts     antigravity-client ラッパ + イベント捕捉  ← パターン#6
    prompts/            フェーズ別システムプロンプト             ← パターン#7,#9
    policy.ts           コマンド/ツール自動承認 allowlist
  tools/                統一プローブIF(全ツールが構造化応答)     ← パターン#5
    dns.ts certs.ts subdomains.ts http.ts whois.ts
    websearch.ts apk.ts(取得+逆コンパイル) shodan.ts ...        ← パターン#1,#3
  findings/
    Graph.ts            エンティティ&関係グラフ(provenance付き)  ← パターン#2,#8
    types.ts
  report/               markdown.ts + json.ts
  safety/
    scope.ts            全ネットワーク呼び出しで allowlist強制    ← パターン#2 + 倫理
    sandbox.ts          成果物解析の隔離
    audit.ts            全アクション監査ログ
```

---

## 3. 各抽象パターンの kyumei 実装方針

### パターン#5 Uniform probe interface(最重要・最初に作る)
全ツールを次の統一形に揃える。これが無いとAI自動化が載らない(元事例のExplorerに相当)。
```ts
interface ToolResult {
  tool: string;
  input: unknown;
  status: "ok" | "blocked_by_scope" | "rate_limited" | "error";
  data: unknown;            // 構造化結果
  raw?: string;             // 生応答(必要時)
  signals: string[];        // 正規化済みの意味タグ(パターン#3)
  operationId: string;      // 証拠ID(パターン#6)
  provenance: { phase: string; ts: string; source: string };
}
type Tool = (input: unknown, ctx: RunContext) => Promise<ToolResult>;
```

### パターン#6 AI=reasoner / code=evidence
- Cascade には **方針決定・分類・深掘り判断**のみさせる。
- probe(=実調査)・スコープ検証・網羅性確認は**決定的コード**が担う。
- 全 finding に `operationId` を必須化し、AIの主張を実データに紐付け(捏造不可)。

### パターン#7 Classify-then-deepen
- **Phase 1** = 浅く広く徹底収集(ユーザー要望「最初は浅く広く」に直結)。
- AIに発見を**論理グループに分類**させ、各グループを**Phase 2以降で深掘り**。
- 前グループの発見を次へ引き継ぐ(findings/Graph 経由)。

### パターン#8 Differential probing
- 複数視点(異なる解像度/地域/認証状態/User-Agent等)で同一観測を行い、**応答差分だけを信号化**。
- findings/Graph に「観測条件 × 応答ハッシュ」で記録し、ユニーク差分を AI に提示。

### パターン#9 Noise-first prompting
- `agent/prompts/` に**フェーズ別**で「報告する/しない」の境界を明文化。
- 反復改良できるよう、プロンプトは**バージョン管理 + 実走ログとの突合**を前提に置く。

### パターン#10 Recursive seed reflux
- `Orchestrator` が findings から**新シード**(新ドメイン/ホスト/アプリ/識別子)を抽出し、Phase 1/2 へ再投入。
- 収束条件: 深さ上限 / 予算超過 / 新規発見ゼロ。

---

## 4. データモデル: findings/Graph(パイプラインの背骨)

元事例が「キー・API・project番号・SA名」を相互に紐付けて還流させたように、kyumei は**ナレッジグラフ**を中核に置く。

```
Entity 型: Org, Domain, Subdomain, IP, ASN, Service, Endpoint,
           MobileApp, Artifact, Secret, ThirdPartySDK, Identifier
Edge:      resolves_to, hosts, owned_by, references, derived_from, found_in
各ノード/エッジ: provenance(phase, tool, operationId, ts, confidence)
```
- **provenance必須** = 監査可能性 + 反ハルシネーション(パターン#2,#6)。
- グラフの「未探索ノード」が pivot ループの次のシードになる(パターン#10)。

---

## 5. 安全機構(元事例の「許可枠組み」を制度化)

| 機構 | 実装 | 対応 |
|------|------|------|
| スコープ allowlist | `safety/scope.ts`。全ツールが呼び出し前に検証。範囲外=`blocked_by_scope` | doc02 Phase B / 倫理 |
| レート制限・予算 | `config.ts` の上限 + RunContext で消費追跡 | doc02 横断原則 |
| 監査ログ | `safety/audit.ts`。全 ToolResult を追記 | パターン#6 |
| サンドボックス | `safety/sandbox.ts`。APK逆コンパイル等を隔離dirで | doc02 横断原則 |
| 承認ポリシー | `agent/policy.ts`。能動的/不可逆操作は allowlist | doc02 横断原則 |

---

## 6. 実装の最小一歩(提案)

抽象パターン#5(正規化)が全ての土台なので、ここから着手するのが最短:

1. **プロジェクト雛形**: package.json / tsconfig / ディレクトリ。
2. **safety/scope + audit**: allowlist強制と監査ログ(他の全ツールが依存)。
3. **tools/ の統一IF + 2〜3個の決定的ツール**(dns, http, certs)で `ToolResult` を確立。
4. **CascadeAgent 最小動作**: antigravity-client に接続し、1プロンプト実行 + イベント捕捉。
5. **Orchestrator + Phase 1(浅く広く)** を最小実装し、findings/Graph に蓄積。
6. 以降、Phase 2〜5 と pivot ループ、Artifact(APK)解析を拡張。

> この順序なら、各ステップが単体で動作確認でき、元事例の「正規化 → AI自動化 → 還流」の依存関係に沿って積み上げられる。

---

## 7. 元事例と kyumei の対応まとめ(1枚)

```
brutecat(Google)            kyumei(汎用OSINT/インフラ調査)
──────────────────────────  ──────────────────────────────
APK 61,200版 grep          → tools/apk.ts(取得+解析) + Phase1/3
project番号→所有判定        → safety/scope.ts(決定的allowlist)
discovery doc + ラベル列挙  → tools/(spec取得) + Phase2 表層列挙
sourcemap→FPA v2 実装       → tools/apk.ts でendpoint/SDK/host抽出
カスタムAPI Explorer       → tools/ 統一 probe IF(ToolResult)
MCP 3ツール + グループ分類  → CascadeAgent + Phase別prompt + Graph
マルチキーprobing+hash重複  → Differential probing(findings/Graph)
1ヶ月のプロンプト改良       → agent/prompts/(noise-first, 版管理)
発見の還流                  → Orchestrator pivot ループ
bugSWAT(許可枠組み)        → safety/(scope/rate/audit/sandbox)
```
