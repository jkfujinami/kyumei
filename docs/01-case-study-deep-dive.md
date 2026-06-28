# 01. ケーススタディ徹底分析: "Hacking Google with AI for $500,000"

> 元記事: https://brutecat.com/articles/hacking-google-with-ai/
> 著者: Arvin Shivram (brutecat) / 文脈: Google bugSWAT (2025年10月, メキシコ) 招待研究
>
> 本ドキュメントは記事の手法を **段階的に(Step by step)** 紐解き、「なぜそれが機能したのか」という設計原理まで掘り下げる。次の [02-abstracted-methodology.md](./02-abstracted-methodology.md) で、ここから汎用パターンを抽出する。

---

## 0. 全体像 (TL;DR)

| 指標 | 値 |
|------|-----|
| 報奨金合計 | 約 **$500,000** |
| 脆弱性件数 | **25件以上**(19+カテゴリ) |
| 調査対象API | 約 **1,500** |
| 収集したAPIキー | 約 **3,600** |
| 解析したAndroid APK | **61,200** バージョン |
| 傍受したGoogle Webドメイン | **2,800+** |
| AI検出精度(改良後) | **50%以上** |
| 期間 | 約 **3ヶ月**(プロンプト改良に1ヶ月以上) |

**一文で言うと**: 「鍵と仕様を**大量に**集めて(広さ)、ターゲットを**一様に叩ける**ツールに正規化し、**AIに意味的な脆弱性判断を、決定的コードに広さ・検証・反ハルシネーションを**分担させた」。

この事例の本質は脆弱性そのものではなく、**「広大でノイズだらけの探索空間を、産業化された発見パイプラインに変換した」設計** にある。以下、その変換を一段ずつ分解する。

---

## 1. なぜこの問題は「難しい」のか(問題設定)

手作業の限界を理解すると、自動化設計の必然性が見える。攻撃対象領域は次の積で爆発する:

```
探索空間 ≈ (APIの数 1,500) × (各APIのメソッド数 数十) × (APIキー 3,600)
            × (visibilityラベルの組合せ) × (IDパラメータの取りうる値) × (環境: prod/staging)
```

- **広さの問題**: 人間が1,500 API × 数十メソッドを総当たりするのは非現実的。
- **ノイズの問題**: Googleのエラー応答は **意図的に曖昧**(例: 認可不足でも "Method not found" を返す)。生の応答を見ても「脆弱なのか、単に存在しないのか」が判別できない。
- **検証の問題**: 同じリクエストでも、どのAPIキー(=どのGCPプロジェクト権限)で投げるかで結果が変わる。
- **AI固有の問題**: AIに丸投げすると (a) すぐ「テスト完了」と早期離脱する、(b) JSONダンプでコンテキストを浪費する、(c) 「潜在的脆弱性かも」とハルシネーションでノイズを量産する。

→ つまり **「広さ・正規化・検証・AI制御」の4つを別々に解かないと成立しない**。記事のパイプラインはこの4つに正確に対応している。

---

## 2. パイプライン全体図

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1  資産・鍵の大量収集 (Breadth)                                   │
│   APK 61,200 / iOS IPA / バイナリ / Chrome傍受 2,800ドメイン           │
│         → 3,600 APIキー + キー制約(referer/package/cert/bundle)        │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 2  スコープ判定 (Ownership filtering)                             │
│   エラーからproject番号抽出 → Cloud Marketplace APIで所有ドメイン確認   │
│         → google.com 由来でないキーを破棄                              │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 3  API発見 (Surface enumeration)                                 │
│   discovery documents 収集 → visibilityラベル列挙(隠れAPI露出)        │
│   serverヘッダ(ESF/GSE/HTTPServer2)で生存判定 → 1,500 API             │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 4  認証・認可の解明 (Protocol RE)                                 │
│   sourcemap漏洩(gapix)からFPA v2 を実装 → 10層の検証パイプライン解明   │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 5  カスタムAPI Explorer (Normalization)                          │
│   discovery doc をクライアント側解析 → 任意APIを一様に叩ける基盤        │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 6  AIファジング自動化 (Reasoning at scale)                       │
│   MCP 3ツール + グループ分類 + エラー正規化 + マルチキー probing        │
├─────────────────────────────────────────────────────────────────────┤
│ STEP 7  プロンプト反復 (Signal/Noise制御)                             │
│   「何が脆弱性で何が違うか」を1ヶ月かけて定義 → 精度50%+               │
└─────────────────────────────────────────────────────────────────────┘
       ↑ STEP4/6で得た新ホスト・SA名・project番号は STEP2/3 へ還流(再帰深掘り)
```

以下、各STEPを丁寧に展開する。

---

## STEP 1 — 資産・鍵の大量収集(広さの確保)

**狙い**: 攻撃の「燃料」=APIキーを、考えうる全ての配布チャネルから根こそぎ集める。

| ベクトル | 規模 | 手法 |
|---------|------|------|
| Android APK | 61,200バージョン | APKMirrorから「全Googleアプリの全バージョン」をスクレイプ → 展開して `grep` で埋め込みキー抽出 |
| Web traffic | 2,800+ドメイン | Chrome Debugger API を使った拡張機能でライブ通信を傍受 |
| iOS | — | IPAを復号(Uptodown経由)してバイナリ解析 |
| バイナリ | — | 入手可能なGoogleバイナリを解析 |

**丁寧に紐解くポイント**:
- 「全バージョン」を集めるのは、**古いバージョンに残った/新版で消えたキーや、ローテーション前のキー**を拾うため。スナップショット一回では不十分。
- 同時に **キーの制約情報も保存**した: Server(IP), Browser(Referer), Android(`X-Android-Package` + `X-Android-Cert` SHA-1), iOS(`X-Ios-Bundle-Identifier`)。これは STEP5/6 で「正しいヘッダを付けて叩く/ブルートフォースする」ために必須。
- **重要な観測**: あるサービスのキーは、そのGCPプロジェクトで**他の多数のAPIも有効化**していることが多い。→ 1つのキーが複数APIへの入口になり、攻撃対象が乗算的に増える。

> 設計教訓: 広さは「一回のスキャン」ではなく「全チャネル × 全履歴」で確保する。そして資産は**メタデータ(制約条件)込み**で保存する。

---

## STEP 2 — スコープ判定(集めた鍵を「対象だけ」に絞る)

**問題**: 大量に集めたキーには Google 以外(サードパーティ)のものが混在する。バウンティ対象=google.com所有プロジェクトのみに絞る必要がある。

**手法(連鎖)**:
1. APIを叩いてわざとエラーを出す → エラー文に project 番号が漏れる
   例: `Protos API has not been used in project 244648151629`
2. その project 番号を Cloud Marketplace API の `/v1test/infoSharing/test/test/<projectNumber>` に通すと、**所有企業のドメイン**が返る。
3. `google.com` 由来でないキーを破棄。

> 設計教訓: **「エラーメッセージは情報漏洩源」**。そして**スコープ判定はプログラム的・決定的に**行う(人手判断やAI判断に任せない)。これは後の「対象外への誤爆防止」にも直結する。

---

## STEP 3 — API発見(隠れた攻撃対象を炙り出す)

**鍵概念: discovery documents** = Googleの機械可読API仕様(メソッド・パラメータ・スキーマ定義)。公開APIにも内部サービスにも存在するが、多くは有効なAPIキーが必要。

**発見の3手法**:

### 3-a. discovery document の収集
有効キーで各APIの `$discovery/rest` を取得 → メソッド・スキーマを機械可読で入手。これが後段(STEP5のExplorer、STEP6のグループ分類)の土台になる。

### 3-b. visibility ラベル列挙(★最重要の発見)
特定のGCPプロジェクトだけが見られる **隠れエンドポイント** が存在し、`labels` パラメータで露出が変わる。

```
GET /$discovery/rest                       → 253k bytes
GET /$discovery/rest?labels=GOOGLE_INTERNAL → 329k bytes  (隠れAPIが大量に出現)
```

- `labels` は**1回に1ラベルしか受け付けない** → **既知の全ラベル × 全APIキー** を総当たりする必要があった(=自動化必須の組合せ爆発)。
- "Method not found" の正体が「メソッドが無い」ではなく「キーのプロジェクトに必要なvisibilityラベルが無い」だと判明したのもここ(STEP6のエラー正規化に繋がる)。

### 3-c. 生存判定(どのホストが本物のGoogle APIか)
- **serverヘッダのシグネチャ**: `ESF` / `GSE` / `HTTPServer2`(scaffolding)があれば、稼働中のGoogle APIサービス。
- ホスト名の発見源: **証明書透明性ログ(Certificate Transparency)** + キーワードからの**ブルートフォース生成**。

→ 結果として **1,500+ API** に discovery document を収集。

> 設計教訓: 「攻撃対象=機械可読仕様 + パラメータで露出が変わる隠れ面 + シグネチャによる生存判定」。**仕様(discovery doc)を持っていることが、後の全自動化の前提**になる。

---

## STEP 4 — 認証・認可の解明(どう「正しく」叩くか)

ターゲットを一様に叩くには、認証プロトコルの完全理解が要る。最大の障壁が **First-Party Authentication v2 (FPA v2)**。

### 4-a. 近道: sourcemap漏洩
ゼロから難読化JSをリバースするのではなく、`android-review.googlesource.com` に**誤って漏れていたsourcemap**から内部ライブラリ **gapix** のソースを入手 → FPA v2をそのまま実装。

> 設計教訓: **「リバースする前に、漏れた仕様を探せ」**。sourcemap/デバッグシンボル/公開リポジトリは、リバースエンジニアリングを丸ごとスキップさせる。

### 4-b. FPA v2 トークンの構造
```
形式:    <timestamp>_<sha1hash>_<identifier_keys>
SHA1入力: "email:gaiaId timestamp sessionCookie origin"
例:       1739700391_abc123def456_eua
```
識別子キー: `e`=email, `u`=難読化Gaia ID, `a`=Workspaceドメイン。`origin` はAPIごとのホワイトリストで検証される。

### 4-c. APIキー制約(4種)
| 種別 | 必要ヘッダ | 備考 |
|------|-----------|------|
| Server | IPホワイトリスト | 回避不可 |
| Browser | HTTP `Referer` / origin | 検証あり |
| Android | `X-Android-Package` + `X-Android-Cert`(SHA-1) | STEP1で収集した値を使用 |
| iOS | `X-Ios-Bundle-Identifier` | 同上 |

→ 収集済みの制約値を使い、足りない場合は**ブルートフォースも同じプログラムに統合**。

### 4-d. リクエスト処理の10層パイプライン(★認可の地図)
記事はGoogle側の検証順序を解明した。これが「どこに認可の穴があるか」を探す地図になる:

```
[1] *.googleapis.com 到達        → [2] メソッド解決(HTML404 vs JSON error)
[3] Content-Type                 → [4] APIキー有効/有効化済み
[5] APIキー制約(IP/referer/pkg)  → [6] 認証クレデンシャル検証
[7] FPA origin ホワイトリスト     → [8] APIキーのproject == bearerのproject
[9] visibility ラベル要件        → [10] メソッド単位のアクセス制御
```

**丁寧に紐解くポイント**: 脆弱性のほとんどは **[10] メソッド単位の認可が欠落** していたケース。[1]〜[9]を全て通過させる(=正規ユーザーに見せかける)ことで初めて[10]の欠落をテストできる。STEP5のExplorerは「[1]〜[9]を自動で満たす装置」。

### 4-e. origin ホワイトリストの内部構造
proto定義 `gaia_mint.AllowedFirstPartyAuth` に enforcement レベル:
`MONITORING_ONLY` / `PRODUCTION_ORIGINS_ONLY` / `ENFORCE_ALL` / `legacy_allow_all_origins`。
**`*.corp.google.com` を origin に使うと制約が無い** ものがあり、「本来公開されるべきでない内部API」を炙り出せた。

---

## STEP 5 — カスタムAPI Explorer(ターゲットの「正規化」)

**問題**: GoogleのAPI Explorerは公開APIしか扱えず、ページはサーバー側生成。内部/非公開APIを叩けない。

**解決**: 自作フロントエンドで——
- discovery document を**クライアント側で解析**
- 自作ライブラリで **FPA v2 トークンを生成**(STEP4)
- discovery doc のスキーマから **リクエスト/レスポンスJSONを自動構築**
- **任意のAPI**に対して実リクエストを実行し、実応答を可視化 → 手動テストの高速フィードバック

> 設計教訓(最重要): **「不均質なターゲットを、単一の一様なインターフェースに正規化する」**。一度 `probe(api, method, params)` という統一操作に落とせば、その上にAI自動化を載せられる。この正規化レイヤが無ければSTEP6は成立しない。

---

## STEP 6 — AIファジング自動化(意味的推論を規模で回す)

正規化された `probe` 操作の上に、AI(Claude)を **MCP(Model Context Protocol)** で接続。

### 6-a. MCP 3ツール構成
| ツール | 役割 | 反ハルシネーション設計 |
|--------|------|----------------------|
| `probe_api` | エンドポイントにペイロード送信。**operation_idを返す**(後で証拠参照) | 当初はhostname/method/discovery IDを要求 → **host/versionを裏で追跡**し、エンドポイント名+パスだけに簡素化(AIが値を捏造する余地を削減) |
| `report_vulnerability` | 発見を記録。**probe_apiのoperation_idを必須**とする | レポートの `{{op_005}}` を「実際に送られたリクエスト(捏造不可)」のUIに置換 |
| `confirm_testing_complete` | 完了宣言。**全in-scopeエンドポイントのテスト済みをシステムが検証** | AIの早期離脱を防止 |

### 6-b. グループベース分類(コンテキスト管理)
無構造ファジングは失敗した(「数回probeして早期離脱」)。改善策:
1. AIに全エンドポイントを**論理グループに分類**させる(根拠付き。例:「これらはAPK技術詳細を取得する主要IF」)。
2. 1グループ=1つの集中ペンテストセッションにする。
3. **前グループの発見を次グループに引き継ぐ**(同一API内)。
4. スコープ外エンドポイントは `get_endpoint_context` でスキーマ取得してからでないとprobe不可。

> 設計教訓: **「大きな対象を、AIが一度に扱える意味的単位に分割し、発見を引き継ぐ」**。コンテキスト管理=分割+引き継ぎ。

### 6-c. エラー正規化(ノイズ→意味)
生のエラーJSONを渡さず、**意味タイプに変換**してAIに渡す:
| 生応答 | 正規化後の意味 |
|--------|--------------|
| `NOT_FOUND`(404 JSON) | **MISSING_REQUIRED_VISIBILITY_LABEL**(メソッドが無いのではなく、キーのprojectにラベルが足りない) |
| `INVALID_ARGUMENT`(400) | **INVALID_ARGUMENT_NO_DETAILS** + 説明文 |

### 6-d. マルチキー probing + ハッシュ重複排除(水平スケール)
- `probe_api` は**同一リクエストを全既知APIキーで自動送信**。
- 結果を**レスポンスハッシュでグルーピング** → 「大半のキーで同一応答」をAIに見せず、**ユニークな応答(=権限差で挙動が変わった=脆弱性の兆候)だけを浮かび上がらせる**。
  - 例: あるキーで `200`、別キーで `404` → 認可差の存在を示唆。

> 設計教訓: **「同じプローブを複数クレデンシャルで投げ、応答の差分だけを信号として抽出する」**。これは認可バグ検出の本質(=誰かには見えて誰かには見えない=認可の穴)。

---

## STEP 7 — プロンプトの反復(Signal/Noiseの制御)

**1ヶ月以上**プロンプトを改良。核心は「**何が脆弱性で、何が脆弱性でないか**」を厳密に定義してノイズを消すこと。

最終システムプロンプトの要点:
- **エンドポイント網羅**: 「下記が**存在する唯一の**エンドポイント。これらが完全かつ正典」(AIの空想的探索を抑制)。
- **ID列挙の扱い**: 「IDを列挙できること自体は脆弱性ではない。**機密データに実際にアクセスできた時だけ**報告せよ」。
- **存在オラクルの除外**(これがノイズ問題の決定打):
  > "NEVER report that you can detect whether an ID exists (e.g., different responses for valid vs invalid IDs). This is NOT a vulnerability unless it leaks sensitive information like emails, names, or private data."
- **重大度の較正**: 「500 / 401 / 403 / 404 / 400(無効パラメータ)は報告するな」。
- **ID列挙はテスト手法として実行**: 数値IDを見つけたら即座に ±1、および小さい値(1,2,3,100,1000)を試せ。
- **証拠の強制**: 全レポートは `probe_api` の operation_id を引用必須(=捏造不可)。

**結果**: 「AIが**左右に脆弱性を見つけ始め、精度50%以上**」。律速はAIの能力ではなく**利用可能なAPIキーの数**になった。

> 設計教訓: **AI自動化の成否は「発見ロジック」より「Signal/Noiseの定義」で決まる**。「何を報告しないか」を厳密に書くことが、実用精度の鍵。

---

## 8. 代表的な脆弱性(手法が生んだ成果)

ほぼ全てが **「[10]メソッド単位の認可欠落」** か **「staging→production データ同期」** のパターン。

| サービス / エンドポイント | 種別 | 報奨 |
|--------------------------|------|------|
| Google Voice `BssGetVoiceSettings` | 認可完全欠落 → PII/復旧電話番号漏洩・任意番号割当(SIMスワップ起点) | $20,000 |
| AdExchange `test-...sandbox.google.com` → 本番データ | staging無認可 → 全連絡先漏洩・攻撃者をadmin追加 | $30,000 |
| Eldar `eldar-pa.clients6.google.com`(プライバシー査定) | 内部査定JSON露出。本番遮断後もstaging `autopush-...` で継続 | $26,674 |
| YouTube Content ID `Auto generated asset - <video_id>` | 非公開/限定公開動画IDの列挙 | $12,000 |
| Widevine `alkaliwidevineintegrationconsole-pa` | 署名鍵/AES鍵の無認可取得・`decodeAesKey` | $16,004 |
| Nest `look_up_by_nest_id` × Play Books `owner:add` | Gaia ID→email解決の**クロス連鎖**で所有者特定 | (連鎖) |
| Translation Hub `translationhub.googleapis.com` | 無認可ListOperations(SA名/GCS/Spanner露出)+ クロステナント + GCS窃取(共有SAで任意GCS読出) | $36,500 |
| YouTube TV CMS `alkalitvfilm-pa` | 全キャンペーン読み書き削除・作成者email露出 | $24,000 |
| Vertex AI Retail `conversationalSearchCustomizationConfig` | 任意プロジェクトへPATCH → **プロンプトインジェクション**注入 | $30,000 |
| Cloud Console GraphQL `staging-cloudconsole-pa` | introspection有効 + staging署名検証バイパス | — |

---

## 9. 横断的な「鍵となる洞察」

1. **staging→production データ同期**: `*.sandbox.googleapis.com` が本番DBを指す → 本番をパッチしても**stagingが永続的な侵入路**に。
2. **visibility ラベル**: `GOOGLE_INTERNAL` 等が**隠れたAPI面**を生む。全ラベル×全キーの自動列挙が必須。
3. **エラー=漏洩源**: エラーがSA名(例 `cloud-translation-hub@system.gserviceaccount.com`)・project番号・スキーマを漏らす → 後続攻撃の特権推測に使える。
4. **origin ホワイトリスト**: `*.corp.google.com` を許す設定が「公開意図の無い内部API」を露出。
5. **発見の還流(再帰)**: STEP4/6で得た新ホスト・SA名・project番号を STEP2/3 に戻すと、対象が自己増殖的に広がる。

---

## 10. この事例から学ぶ「設計の3原則」

1. **役割分担**: AIは「意味的判断(これは認可の穴か?)」に専念。広さ・検証・反ハルシネーションは**決定的コード**が担う。
2. **正規化が全ての土台**: 不均質なターゲットを単一の `probe()` に落として初めて自動化が載る。
3. **Signal/Noiseの定義が精度を決める**: 「何を報告しないか」「エラーの真の意味」「差分だけを信号にする」——ノイズ除去こそが実用化の本体。

→ これらを汎用化したものが [02-abstracted-methodology.md](./02-abstracted-methodology.md)。
