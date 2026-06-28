# 06. Phase: Footprint Mapping(breadth)

**表層調査の本体**。狭い「サブドメイン列挙」ではなく、**組織の歴史的フットプリント全体**を掘り起こす。「今あるもの」だけでなく「過去にあった/廃止された/忘れられた」資産まで、カテゴリ×時間のマトリクスを全網羅する。**誰も見てない放置資産を見つけることが価値**。

- `type`: breadth
- `consumes`: `Target` | `Org` | `Domain`
- `produces`: `Org` `Domain` `Subdomain` `IP` `ASN` `Service` `WebApp` `Api` `MobileApp` `Artifact`(参照) `CodeRepo` `CloudAsset` `TechStack` `Person`
- `model`: 速いモデル可(Flash)。網羅性重視・判断は軽い。

## 6.1 中核: カテゴリ × 時間マトリクス(網羅契約)

systemプロンプトに「**このマトリクスの全セルを埋めよ。空欄を残すな**」と明記。

| カテゴリ＼時間 | Live(現役) | Historical(過去・廃止・忘却)★ |
|---|---|---|
| ドメイン/ホスト | subfinder/dnsx/httpx 生存確認 | crt.sh失効証明書, passive DNS履歴, dangling検出 |
| Webサービス | 現役サイト巡回・タイトル/技術 | Wayback, archive.today, 旧UI/旧パス |
| API | 現行EP, JSバンドル/specから抽出 | 廃止/旧版(v1残骸), Waybackの旧API呼び出し |
| モバイルアプリ | Play/App Store現行 | ストア消失アプリ, APKMirror等の旧版全部 |
| コード/クラウド | GitHub現行, 公開バケット | 旧repo, 削除前コミット痕跡, 放置バケット |
| 組織/人 | 現体制, 採用情報の技術 | 買収履歴, 旧ブランド, 旧プレス/ブログ製品発表 |

## 6.2 Collector 群(AI主導の知能ループ単位)

> **重要**: collector は「固定スクリプト」ではなく **AIが回す「知る→翻訳→振る→取り込む」ループ(doc 11)** の目的単位。
> 例: 「組織のプロダクトに何があるか」を AI がWeb検索+推論で発見([1 知る])→ アプリ名をpackage idへ翻訳([2 翻訳])→ 武器庫から apkeep 等を選び実行([3 振る])→ 出力を解釈して finding 化([4 取り込む])。
> AIにしかできない [1][2][4](文脈理解・翻訳・解釈)が価値で、[3] が手下のCLI。
> 各 collector は **目的・使える手下(Tool Arsenal, doc11)・産むentity・status初期判定** を持つ。順序・道具選びはAI裁量、「全部やったか」は網羅チェック(04.5)が決定的に保証する。

### C1. 組織アイデンティティ展開
- 目的: Target→組織・関連法人・買収・旧ブランド・関連ドメイン群。
- 手段: WHOIS/RDAP, Web検索(企業情報/プレス/Crunchbase的情報), 逆WHOIS的検索。
- 産む: `Org`, `Person`, `Domain`(関連)。
- 引き継ぎ: 見つけた旧ブランド名は後続 collector の検索語になる。

### C2. ドメイン/サブドメイン考古学
- 目的: 現役+失効+danglingまでホストを総ざらい。
- 手段: crt.sh / CT(`curl crt.sh`等), passive DNS, subfinder/amass, dnsx で解決確認。
- status: 解決し稼働=`live`、CT/履歴にあるが未解決=`dead`、CNAMEが外部未所有=`abandoned`(dangling, `danglingTo`記録)。
- 産む: `Domain` `Subdomain` `IP`(`resolves_to`), `ASN`。

### C3. 生存・指紋
- 目的: 各ホストの稼働状態と技術指紋。
- 手段: httpx(status/title/server header), tlsx(証明書/SAN→**SANから新サブドメイン**), tech検出(Wappalyzer的)。
- 産む: `Service`(serverHeader/statusCode/title), `TechStack`, 追加 `Subdomain`(SAN由来)。

### C4. Webサービス/プロダクト棚卸し(時間軸★)
- 目的: 現役サイト + **Waybackで過去のサイト/プロダクト/パス**。
- 手段: Wayback CDX API(`web.archive.org/cdx`), archive.today, gau/waybackurls で歴史的URL収集。
- status: 現存=`live`、Waybackのみ=`dead`/`deprecated`。
- 産む: `WebApp`(waybackFirst/Last), `Endpoint`(歴史的パス), `Service`。

### C5. API 痕跡収集(時間軸★)
- 目的: 現行+廃止+旧バージョンAPIの発見。
- 手段: JSバンドル/source map解析(現行EP), Wayback内のAPI呼び出し, `/v1` `/v2` 等のバージョン痕跡, 既知のAPI doc/spec探索。
- 産む: `Api`(version/deprecated), `Endpoint`, `Artifact`(jsbundle/sourcemap参照)。
- 注: 取得・逆解析の深掘りは **AssetAnalysis(07)** へ委譲(ここでは「存在の発見」まで)。

### C6. モバイルアプリ棚卸し(時間軸★)
- 目的: 現行 + **ストアから消えたアプリ + 全旧バージョン**。
- 手段: Play/App Store検索, APKMirror/APKPure/Uptodown でパッケージ・版一覧, 開発者アカウント単位の列挙。
- status: 現行=`live`、ストア消失=`abandoned`、旧版=`deprecated`。
- 産む: `MobileApp`(package/store/versions/removedFromStore), `Artifact`(apk参照, urlのみ。取得は07)。

### C7. コード/クラウド露出
- 目的: 公開リポジトリ・漏洩・放置クラウド資産。
- 手段: GitHub/コード検索(org/旧ブランド名), 公開バケット探索, 既知のクラウド命名規則。
- 産む: `CodeRepo`, `CloudAsset`, `Artifact`(取得候補), `Secret`(痕跡, 要07検証)。

### C8. 検索面の広域スイープ
- 目的: 上記で漏れた露出を Web検索/dork で拾う(PDF/設定ファイル/管理画面/露出ドキュメント)。
- 手段: Cascadeの Web検索 + dork的クエリ。
- 産む: 雑多な `Service`/`Endpoint`/`Artifact`(後続で分類)。

## 6.3 status 付与ロジック(この章の肝)

各 collector が status を申告し、kyumei が機械確認できるものを上書き(01.2):
- 解決可否/HTTP応答: dnsx/httpx の実測で `live` か `dead` を確定。
- dangling: CNAME先が未登録/未所有なら `abandoned`(高interest)。
- ストア消失/長期未更新: `abandoned`/`deprecated`。
- **abandoned/dead/deprecated には自動で interest 加点 + `forgotten` タグ候補**(Triage(05)で深掘り優先)。

## 6.4 buildContext(seed別の文脈)

| seed | 文脈に入れるもの |
|------|----------------|
| Target | 起点ドメイン/組織名のみ(まっさら開始) |
| Domain(reflux) | 親由来情報(例:「このドメインはAPK解析で発見」)+ 既知の兄弟サブドメイン(重複回避) |
| Org | 既知の関連ドメイン群・旧ブランド(同じ組織を二度展開しない) |

## 6.5 expectedActions(網羅チェック; 04.5)

Domain seed の最低充足ライン(欠ければ reprompt):
- [ ] CT/crt.sh 列挙の痕跡
- [ ] passive DNS 参照
- [ ] httpx による生存確認
- [ ] tlsx/証明書 SAN 確認
- [ ] Wayback(CDX)参照 ← **時間軸の取りこぼし防止**
- [ ] モバイル/コードの該当チェック(対象に応じ)

## 6.6 出力例(findings.jsonl)

```jsonc
{ "kind":"entity","type":"Subdomain","value":"old-dashboard.acme.com",
  "status":"dead","tags":["forgotten"],"attrs":{"resolves":false,"waybackLast":"2019-03"},
  "tool":"wayback","evidencePath":"evidence/op_058.txt","confidence":0.8 }

{ "kind":"entity","type":"MobileApp","value":"com.acme.legacy",
  "status":"abandoned","attrs":{"store":"play","removedFromStore":true,"versions":["1.0","1.4"]},
  "tool":"apkmirror","evidencePath":"evidence/op_061.txt","confidence":0.85 }

{ "kind":"entity","type":"Subdomain","value":"cdn-legacy.acme.com",
  "status":"abandoned","tags":["dangling"],"attrs":{"danglingTo":"s3.amazonaws.com/..."},
  "tool":"dnsx","evidencePath":"evidence/op_063.txt","confidence":0.9 }

{ "kind":"phase_complete","covered":["acme.com"],"summary":"sub=42(live18/dead17/abandoned7), apps=3(1消失), webapp歴史=11" }
```

## 6.7 還流への寄与

Footprintが産む `Artifact`(apk/jsbundle)・`MobileApp` → **AssetAnalysis(07)** へ。
AssetAnalysisが解析で産む新 `Domain`/`Subdomain` → **再びFootprint(本章)** へ(reflux)。この往復が深掘りの推進力。
