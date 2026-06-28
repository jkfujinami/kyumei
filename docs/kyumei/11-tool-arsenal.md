# 11. Tool Arsenal & AI ディスパッチループ

kyumei の中核思想を一言で: **AI＝司令官、CLIツール群＝圧倒的な数の手下**。
情報収集も深掘りも、**AIが「知る→翻訳→振る→取り込む」**ことで進む。本章はその仕組み(ディスパッチループ)と、AIが指揮する武器庫(Tool Arsenal)を定義する。

## 11.1 役割分担(知能 vs 筋肉)

| 層 | 担当 | 例 |
|----|------|----|
| 知能(司令官) | **Cascade(AI)** | 「この会社に何のプロダクトがあるか」を推論・Web検索で発見、曖昧情報をツール入力へ翻訳、出力を解釈、次の一手を決定 |
| 筋肉(手下) | **CLIツール群** | subfinder/httpx/apkeep/jadx/gitleaks… 与えられた正確な入力を高速・確実に処理 |
| 監督(参謀) | **kyumei** | 網羅の保証(網羅チェック)・証拠検証・予算・還流。AIに自由を与えつつ漏れと暴走を抑える |

> 「広さは決定的に」= **網羅の"保証"は機械**。**実行の"駆動"はAI**。両立する(doc04の expectedActions がセーフティネット)。

## 11.2 ディスパッチループ(全フェーズ共通のミニループ)

フェーズの中で、AIは資産・目的ごとにこの4段を回す:

```
[1 Discover 知る]   Web検索・推論・既存findingから「対象/手がかり」を発見
                    例: "Acme社のモバイルアプリ" を検索 → AcmeGo, AcmePay, 旧AcmeLite(消滅)
        ↓
[2 Normalize 翻訳]  曖昧な情報を、ツールが食える正確な構造化入力へ
                    例: アプリ名 → {package:"com.acme.go", store:"play"}
        ↓
[3 Dispatch 振る]   武器庫から適切なツールを選び、正確な入力で実行(exec層経由)
                    例: apkeep -a com.acme.go → artifacts/com.acme.go.apk
        ↓
[4 Ingest 取り込む] 出力を解釈し finding 化。新たな手がかりは [1] へ、新資産は還流へ
                    例: jadx+rg → 内部ホスト api-internal.acme.com(新Domain=reflux)
```

- **[1][2][4] が知能(AI)**、**[3] が筋肉(CLI)**。AIにしかできない橋渡し([1][2])こそ価値。
- このループは Footprint(06)でも Asset Analysis(07)でも同じ。違いは目的(網羅 vs 深掘り)だけ。

## 11.3 具体例: プロダクト発見 → APK解析の連鎖

ユーザーが挙げた「プロダクト発見→APKダウンローダ→解析」を1本で:

```
Discover : Web検索「Acme Inc apps / 開発者ページ」+ google-play-scraper(開発者単位)
           → [AcmeGo(現), AcmePay(現), AcmeLite(ストア消滅=abandoned)]
Normalize: 各々を {package, store, versions} に変換。消滅アプリは旧版ミラーを探す前提に
Dispatch : apkeep / apkpure-dl で APK取得 → artifacts/<pkg>.apk (sha256記録)
Dispatch : apktool d / jadx → 逆コンパイル
Dispatch : rg / gitleaks で endpoint・APIキー・内部ホスト抽出
Ingest   : Endpoint・Secret・新Domain を findings.jsonl へ(証拠パス付き)
           → 新Domain は Footprint へ reflux、旧版アプリは「忘れられた資産」として高interest
```

**消えたアプリ(abandoned)の旧版APKに、現行バックエンドの内部エンドポイントが残ってる**——これが「見落とし狙い」の典型で、AIが文脈で辿り着く。

## 11.4 Tool Arsenal(武器庫)レジストリ

AIが「自分の手下」を把握するためのカタログ。各ツールを構造化記述し、**プロンプトに提示**する(関連カテゴリのみ抜粋して渡す)。

```ts
interface ToolSpec {
  name: string;
  category: ToolCategory;
  purpose: string;             // 何をする手下か
  install?: string;            // 入手方法(不在時AIが導入できるよう)
  inputContract: string;       // 何を渡すか(例: "package id", "domain", "apk path")
  outputShape: string;         // 何が返るか・どうパースするか
  whenToUse: string;           // 使いどころ
  chainsTo?: string[];         // 典型的な次の手下(連鎖の道しるべ)
  evidenceHint: string;        // 何を evidence/ に残すか
  caution?: string;            // 注意(レート・規約・有害化しない範囲)
}

type ToolCategory =
  | "identity" | "dns_subdomain" | "cert_archive" | "http_fingerprint"
  | "mobile_apk" | "code_secrets" | "cloud" | "search_osint" | "generic";
```

レジストリは `src/agent/arsenal/*.ts`(or yaml)で定義し、`config.tools` で有効/無効を切替。

## 11.5 武器庫の中身(初期カタログ案)

| category | 代表ツール(手下) | 入力→出力 |
|----------|------------------|-----------|
| identity | whois, rdap, web検索 | 組織/ドメイン → 関連法人・旧ブランド・関連ドメイン |
| dns_subdomain | subfinder, amass, dnsx, puredns, massdns | ドメイン → サブドメイン・解決結果 |
| cert_archive | crt.sh(curl+jq), tlsx, gau, waybackurls, wayback CDX | ドメイン → 証明書/SAN・歴史的URL |
| http_fingerprint | httpx, whatweb, wappalyzer, nuclei(info) | host列 → status/title/server/技術指紋 |
| mobile_apk | google-play-scraper, apkeep, apkpure-dl, apktool, jadx, dex2jar | アプリ名/package → APK取得 → 逆コンパイル → endpoint/鍵 |
| code_secrets | gh(GitHub検索), trufflehog, gitleaks | org名/repo/ファイル → 露出コード・秘密痕跡 |
| cloud | cloud_enum, s3scanner | 命名キーワード → 公開バケット/クラウド資産 |
| search_osint | theHarvester, dork(Web検索) | 組織/ドメイン → メール・ホスト・露出資産 |
| generic | curl, jq, ripgrep(rg), grep | 任意 → 取得・抽出・整形(連鎖の接着剤) |

> 「圧倒的なCLIツール」= このカタログを継続拡充する。AIは**カタログ外のツールも自律導入してよい**(発見は監査に残す)。カタログは出発点であって檻ではない。

## 11.6 AIへの提示方法(プロンプト統合)

- PhaseRuntime(04)の system/手法ブロックに、**そのフェーズに関連するカテゴリのToolSpec要約**を埋め込む。
  - Footprint → identity/dns_subdomain/cert_archive/http_fingerprint/search_osint/mobile_apk(発見まで)。
  - Asset Analysis → mobile_apk(取得+解析)/code_secrets/cloud/http_fingerprint/generic。
- 提示形式(例):
  ```
  ## 使える手下(必要なら自分で導入してよい)
  - apkeep [mobile_apk]: package id を渡すとAPKをDL。入力=com.x.y / 出力=apkファイル。
    次の手下: apktool, jadx。証拠: DLログとsha256を残せ。
  - jadx [mobile_apk]: apk path を渡すとソース復元。次: rg/gitleaks で grep。
  ...
  ```
- **chainsTo を見せることで、AIが連鎖(取得→解析→抽出)を組み立てやすくなる**。

## 11.7 Normalize(翻訳)を助ける規約

AIが [2 Normalize] を正確にやるための約束事:
- 発見した「曖昧な対象」も一旦 entity として findings に出してよい(`status:unknown`)。
- ツールに渡す**構造化入力を finding の attrs に明記**(例 MobileApp.attrs.package)。次のディスパッチがそれを使う。
- 翻訳に推測が入る場合は confidence を下げ、**検証ステップ(ストア確認等)を必ず挟む**(誤ったpackageでツールを走らせない)。

## 11.8 exec層・証拠との関係(再掲)

- ディスパッチ[3]は必ず **exec層(09)** を通る → 監査・operationId採番・(将来)scope照合。
- 各ツール出力は `evidence/<operationId>` に保存 → finding の `evidencePath` になる(反ハルシネーション)。
- つまり **「AIが手下に出した命令」と「その結果」は全部記録され、後から再現・検証できる**。

## 11.9 まとめ(この章の要点)

1. AI＝司令官、CLI＝手下、kyumei＝参謀。
2. 情報収集も **AI主導の「知る→翻訳→振る→取り込む」ループ**。曖昧情報をツール入力に翻訳する知能労働がAIの核心価値。
3. **Tool Arsenal** でAIに手下を把握させ、連鎖(プロダクト→APK→解析→還流)を組ませる。
4. 武器庫は拡充前提・AIの自律導入も許容。網羅と安全は kyumei が決定的に担保。
