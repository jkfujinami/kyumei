# 01. データモデル — Findings Graph

調査の全状態を保持する**ナレッジグラフ**。エンティティ(ノード)+エッジ(関係)+provenance(出所)で構成。Frontierの次タスクもレポートもここから派生する=パイプラインの背骨。

## 1.1 エンティティ型

```ts
type EntityType =
  | "Target"        // 調査起点
  | "Org"           // 組織・法人(買収/旧ブランド含む)
  | "Person"        // 関係者(OSINTで判明)
  | "Domain"        // 登録ドメイン
  | "Subdomain"     // サブドメイン(dangling含む)
  | "IP"            // IPアドレス
  | "ASN"           // 自律システム
  | "Service"       // 稼働サービス(HTTPサイト/ポートサービス)
  | "WebApp"        // Webアプリ/プロダクト(現役・廃止)
  | "Api"           // API(現役・廃止・旧バージョン)
  | "Endpoint"      // 個別エンドポイント/パス
  | "MobileApp"     // モバイルアプリ(ストア現行・消失・旧版)
  | "Artifact"      // 取得対象/取得済み成果物(APK/JS/source map/バケット)
  | "CodeRepo"      // 公開リポジトリ
  | "CloudAsset"    // バケット/関数/コンテナ等
  | "TechStack"     // 技術指紋(framework/server/CDN/SDK)
  | "Secret"        // 鍵/トークン/資格情報の痕跡
  | "Hypothesis";   // AIが立てた調査仮説(エンティティとして保持=追跡可能に)
```

### エンティティ共通フィールド
```ts
interface Entity {
  id: string;                 // 安定ID(後述の正規化キーのhash)
  type: EntityType;
  value: string;              // 主表現(例: "api.acme.com", "com.acme.app")
  attrs: Record<string, unknown>;  // 型別の追加属性(後述)
  status: AssetStatus;        // live/deprecated/dead/abandoned/unknown
  firstSeenDepth: number;     // 何ホップ目で初発見か(reflux分析用)
  interest: number;           // Triageが付ける興味度スコア 0..1
  tags: string[];             // "internal","staging","forgotten" など
  provenance: Provenance[];   // 複数ソースから来うるので配列
  createdAt: string; updatedAt: string;
}

type AssetStatus = "live" | "deprecated" | "dead" | "abandoned" | "unknown";
```

### 型別 attrs(主要なもの)
| type | attrs例 |
|------|--------|
| Domain/Subdomain | `registrar, createdDate, expiryDate, resolves(bool), danglingTo` |
| IP | `ptr, geo, openPorts:number[]` |
| Service | `scheme, port, statusCode, serverHeader, title, screenshotPath` |
| WebApp/Api | `version, baseUrl, deprecated(bool), waybackFirst, waybackLast, specUrl` |
| MobileApp | `package, store, currentVersion, removedFromStore(bool), versions:string[]` |
| Artifact | `kind:"apk"|"jsbundle"|"sourcemap"|"bucket"|..., url, localPath, sha256` |
| TechStack | `name, category, version, evidence` |
| Secret | `kind, redactedSample, locationPath, validated(bool)` |
| Hypothesis | `statement, rationale, targetEntityId, status:"open"|"confirmed"|"refuted", testTaskIds` |

## 1.2 status の定義と判定(見落とし狙いの核)

| status | 意味 | 主な判定根拠 |
|--------|------|------------|
| `live` | 現役・応答あり | httpx 2xx/3xx、ストア現行、DNS解決+稼働 |
| `deprecated` | 公式に旧扱いだが残存 | 旧APIバージョン、"legacy"パス、deprecatedヘッダ |
| `dead` | 痕跡はあるが今は応答なし | CT/Waybackにあるが解決せず/404 |
| `abandoned` | 放置・所有曖昧 | dangling CNAME、ストア消失アプリ、長期未更新、失効間際証明書 |
| `unknown` | 未判定 | 発見直後 |

- **判定はPhaseRuntimeの後処理 + AIの申告の併用**。AIが`status`を申告し、kyumeiが機械確認できる項目(解決可否等)は上書き検証。
- **Triageは `dead`/`abandoned`/`deprecated` と `tags:["internal","staging"]` を高スコア化**(05参照)。

## 1.3 エッジ(関係)

```ts
type EdgeType =
  | "resolves_to"     // Subdomain -> IP
  | "hosts"           // IP -> Service
  | "owned_by"        // Domain -> Org
  | "belongs_to"      // Subdomain -> Domain, Endpoint -> Api
  | "runs"            // Service -> TechStack/WebApp/Api
  | "references"      // Artifact -> Endpoint/Secret/Domain(解析で判明)
  | "derived_from"    // 新Domain derived_from Artifact(reflux履歴)
  | "published_by"    // MobileApp/WebApp -> Org
  | "tests"           // Hypothesis -> 対象Entity
  | "found_in";       // Secret found_in Artifact

interface Edge {
  id: string;
  type: EdgeType;
  from: string; to: string;   // Entity.id
  attrs?: Record<string, unknown>;
  provenance: Provenance[];
}
```

`derived_from` は**還流の系譜**を記録する(「この内部ドメインはどのAPKから出たか」が後で追える=レポートの説得力と再現性)。

## 1.4 Provenance(出所)— 反ハルシネーションの土台

```ts
interface Provenance {
  phase: string;            // 発見したフェーズid
  tool?: string;            // 使ったCLI/検索(申告ベース)
  operationId?: string;     // 証拠ファイルのID(evidence/<operationId>.*)
  evidencePath?: string;    // 証拠実体への相対パス
  ts: string;
  confidence: number;       // 0..1(AI申告 or ルール)
  note?: string;
}
```
- **少なくとも1つの provenance に `evidencePath` があること**を merge時に要求(無ければ "unverified" タグを付け interest を減点、レポートでは別枠)。

## 1.5 findings.jsonl(AIの出力契約)

Cascade は発見を **1行1JSON** で `findings.jsonl` に追記する。これがAIとkyumeiの境界面。

```jsonc
// finding レコード
{ "kind":"entity", "type":"Subdomain", "value":"staging.acme.com",
  "status":"abandoned", "attrs":{...}, "tags":["staging"],
  "evidencePath":"evidence/op_017.txt", "tool":"tlsx", "confidence":0.9,
  "note":"TLS SANに出現、解決するが502" }

{ "kind":"edge", "type":"derived_from", "from":"<apkId>", "to":"<domainId>",
  "evidencePath":"evidence/op_031.json" }

{ "kind":"hypothesis", "statement":"旧API v1が認証無しで残存",
  "rationale":"waybackに/v1/users、現行は/v2のみ", "targetValue":"api.acme.com",
  "evidencePath":"evidence/op_044.txt", "confidence":0.6 }

{ "kind":"phase_complete", "summary":"...", "covered":["acme.com","acme.io"] }
```

- `kind`: `entity` | `edge` | `hypothesis` | `phase_complete`。
- value→id解決は kyumei 側で正規化(1.7)。AIにIDを生成させない(捏造防止)。

## 1.6 Store API(findings/store.ts)

```ts
function appendFinding(runId, record): void          // Cascade経由ではなく、検証後にkyumeiが正規化保存する場合に使用
function readFindingsDelta(runId, sinceOffset): { records: RawFinding[], newOffset: number }
                                                     // findings.jsonl の未読分だけ読む(PhaseRuntimeが使用)
function snapshotGraph(runId, graph): void           // graph.json を書き出し
function loadGraph(runId): FindingsGraph              // 再開用
```
`readFindingsDelta` は**オフセット管理**で「そのフェーズで増えた分」だけを回収する(04のevidence検証へ渡す)。

## 1.7 Graph API(findings/Graph.ts)

```ts
class FindingsGraph {
  upsertEntity(partial): Entity            // 正規化キーで同一性判定しmerge(1.8)
  addEdge(edge): Edge
  getEntity(id): Entity | undefined
  find(type, predicate?): Entity[]         // consumes照合・Triage用
  neighbors(id, edgeType?): Entity[]
  byStatus(...status): Entity[]            // Triage用
  unexplored(phaseId): Entity[]            // まだそのフェーズを通してない該当エンティティ
  markExplored(phaseId, entityId): void    // 重複排除(03と連動)
  toJSON() / static fromJSON()
}
```

## 1.8 同一性・正規化(重複爆発を防ぐ)

`upsertEntity` は **正規化キー**で既存ノードと突合し、別ソースの同一物をmergeする:
- Domain/Subdomain: lowercase + 末尾ドット除去 + punycode正規化。
- IP: 正規表記。
- MobileApp: `store:package` をキー。
- Artifact: `sha256`(取得後)/ `url`(取得前)。
- Service: `scheme://host:port`。

merge時: `attrs`は新しい非nullで上書き、`provenance`/`tags`は和集合、`status`は「より確度の高い機械判定 > AI申告」で解決、`interest`は最大値を保持。

## 1.9 不変条件(invariant)

1. 全エンティティは少なくとも1つの provenance を持つ。
2. レポートに採用される finding は `evidencePath` 検証済み(`unverified`タグなし)。
3. `derived_from` 連鎖は循環しない(reflux系譜はDAG)。
4. `firstSeenDepth` は単調(後から浅い深さで再発見しても最小値を保持)。
