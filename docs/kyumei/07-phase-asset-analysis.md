# 07. Phase: Asset Analysis(deepening)

個別資産(プロダクト/サービス/API/アプリ/成果物)を **理解 → 仮説 → 検証** のループで深掘りする。ユーザー要望「各プロダクトを解析、可能性のある方向性の調査、これを繰り返す」の実装。**1 Task = 1 資産**。

- `type`: deepening
- `consumes`: `Artifact` `MobileApp` `Api` `WebApp` `Service` `CloudAsset` `CodeRepo` `Subdomain`(triageで選ばれたもの)
- `produces`: `Endpoint` `Secret` `TechStack` `Hypothesis`(検証結果) + **新 `Domain`/`Subdomain`/`Service`/`Api`**(=reflux源)
- `model`: 賢いモデル推奨(Pro)。意味的判断・仮説生成が主。

## 7.1 内部3ステップ(資産ごと)

```
[理解 Understand]  資産が何か・役割・技術・現役か死んでるかを把握
       ↓
[仮説 Hypothesize] 「調べる価値のある方向性」を複数、根拠付きで列挙
       ↓
[検証 Verify]      各仮説を CLI/検索/取得・解析で確かめる
       ↓
   発見 → findings.jsonl(新エンティティは reflux 源)
```
Triage(05)が渡す `direction`(狙う方向)が **仮説の初期方針**になる。

## 7.2 STEP 理解(Understand)

- 目的: 対象資産の正体・技術スタック・現役性・関連を確定。
- 手段(資産種別で分岐, 7.5):
  - Service/WebApp: トップ/robots/sitemap/JS取得、ヘッダ・技術指紋、ログイン面の有無。
  - Api: discovery/openapi/graphql introspection の有無、バージョン、認証方式。
  - MobileApp/Artifact: 取得(7.4)→ メタ情報(manifest, パッケージ, 署名)。
- 産む: `TechStack`, 確定した `status`, 関連 `Endpoint`。

## 7.3 STEP 仮説(Hypothesize)

AIが **複数の調査方向**を根拠付きで生成し、`Hypothesis` エンティティ(01)として記録。

仮説テンプレ(例。OSINT/解析の範囲で「確かめられる」もの):
| パターン | 例 | 検証で見るもの |
|---|---|---|
| 旧版残存 | 「`/v1` が現行 `/v2` の裏で生存」 | 旧EPの応答有無・挙動差 |
| 設定/秘密の露出 | 「APK内に APIキー/エンドポイント」 | grep/gitleaks の一致 |
| dangling/テイクオーバー兆候 | 「CNAME先未所有」 | 解決先の所有状態 |
| 隠れバックエンド | 「アプリが叩く内部ホスト」 | manifest/コード中のホスト名 |
| 歴史的露出 | 「Waybackに管理画面/設定ファイル」 | 当時のURLの現存性 |
| 公開ストレージ | 「バケットがリスト可能」 | 公開設定・列挙可否 |

各仮説に `score`(調べる価値)を付け、**高いものから検証**。

## 7.4 STEP 検証(Verify)— 成果物取得・解析を含む

Cascadeが仮説ごとにコマンド/検索を実行。**取得系**(deepeningの花形):

### 取得(Acquire)
- APK: APKMirror/APKPure/Uptodown 等から `artifacts/` にDL → `sha256` 記録。
- JSバンドル/source map: 取得して `artifacts/`。
- バケット/公開ファイル: 取得 or リスト。

### 解析(Analyze)
- APK: `apktool`/`jadx` で逆コンパイル → `grep`/`gitleaks` で
  - エンドポイント・ホスト名(**新Domain/Service** = reflux)
  - APIキー・トークン(`Secret`、`validated:false`)
  - 第三者SDK(`TechStack`)
- JS/source map: 復元してエンドポイント/秘密抽出。
- 出力は evidence/ に保存、新エンティティを findings.jsonl へ。

> 注: 秘密(Secret)は **痕跡として記録するに留め**、悪用的な能動利用は範囲外(09の承認ポリシーで制御)。`validated`は「形式的に有効そうか」程度。

## 7.5 資産種別ごとの動作表(1機能単位)

| seed type | 理解 | 主な仮説 | 検証の代表動作 | reflux源 |
|-----------|------|---------|---------------|---------|
| `Artifact:apk` | manifest/署名/パッケージ | 秘密・内部ホスト露出 | jadx+grep+gitleaks | 内部Domain/Endpoint/Secret |
| `MobileApp` | ストア情報/版 | 旧版に残存EP/鍵 | 旧APK取得→解析 | 同上 |
| `Api` | spec/introspection/版 | 旧版残存・認証緩さ | EP応答比較・spec取得 | Endpoint/新Api |
| `WebApp` | JS/パス/技術 | 歴史的露出・設定漏れ | JS解析・wayback突合 | Endpoint/Domain |
| `Service` | ヘッダ/ポート/技術 | 露出管理画面・既知CVE面 | バナー精査・パス探索 | Endpoint/TechStack |
| `CloudAsset` | 種別/命名 | 公開設定・列挙可否 | リスト試行 | Artifact/Endpoint |
| `CodeRepo` | 内容/履歴 | 秘密・内部URL | gitleaks・grep | Secret/Domain |
| `Subdomain(abandoned)` | 解決先/状態 | テイクオーバー兆候 | CNAME所有確認 | (兆候の記録) |

## 7.6 buildContext

- 対象資産の全既知attrs + 近傍(親WebApp, 兄弟Endpoint等)。
- **Triageの `direction`**(狙う方向)を冒頭に提示=深掘りの初期方針。
- 既存の関連 `Hypothesis`(open)を提示し、重複検証を避ける。
- 「ここで見つけた新ドメイン/ホストは必ず findings に出せ(reflux されるので)」と明示。

## 7.7 expectedActions(網羅チェック)

- [ ] 理解ステップの痕跡(取得 or 指紋)
- [ ] 最低1件の `Hypothesis` レコード(方向を明示)
- [ ] 各 open 仮説に対する検証アクション(コマンド/検索)の痕跡
- [ ] 取得した成果物の `sha256` 記録(取得系の場合)

欠落時は reprompt(「仮説X未検証。検証して結果をfindingsへ」)。

## 7.8 出力例(findings.jsonl)

```jsonc
{ "kind":"entity","type":"Endpoint","value":"https://api-internal.acme.com/v1/users",
  "status":"unknown","tags":["internal"],"tool":"jadx+grep",
  "evidencePath":"evidence/op_104.txt","confidence":0.9,
  "note":"com.acme.legacy のAPK内に出現" }

{ "kind":"entity","type":"Domain","value":"api-internal.acme.com",
  "tool":"jadx","evidencePath":"evidence/op_104.txt" }        // ← reflux: Footprintへ戻る

{ "kind":"edge","type":"derived_from","from":"<apkId>","to":"<api-internal.acme.com id>",
  "evidencePath":"evidence/op_104.txt" }

{ "kind":"hypothesis","statement":"内部APIが認証無しで到達可能か",
  "rationale":"APKに内部ホスト+キー。OSINT範囲で到達性のみ確認","targetValue":"api-internal.acme.com",
  "evidencePath":"evidence/op_106.txt","status":"open","confidence":0.5 }

{ "kind":"phase_complete","covered":["com.acme.legacy"],"summary":"内部ホスト2・鍵痕跡1・仮説3(検証2/未1)" }
```

## 7.9 還流(reflux)の駆動

- 産んだ `Domain`/`Subdomain`/`Service`/`Api` は 03 の followup で **Footprint(06)へ自動再投入**。
- `derived_from` で系譜を残すため、レポートで「APK→内部ドメイン→新サービス」という発見の連鎖が再構成できる。
- 仮説(Hypothesis)は status(open/confirmed/refuted)で追跡され、Synthesis(08)で「調べた方向と結論」として要約される。
