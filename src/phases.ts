import type { Entity } from "./findings.js";

export type PhaseId = "footprint" | "assetAnalysis" | "synthesis";

/**
 * 出力契約。Cascade の作業ディレクトリ(cwd)は launch/connect の都合で
 * 我々の workspace とは限らないため、**必ず絶対パス**で書き込ませる。
 */
function outputContract(workdir: string): string {
  return `
## 出力契約(最重要・厳守)
**このフェーズの第一の成果物は findings.jsonl への構造化記録である。** コマンド出力や要約文ではなく、
findings.jsonl に entity を書くことが本体の仕事。**何か見つけるたびに、その都度** 次の絶対パスのファイルに
「1行1JSON」で**即追記**すること(最後にまとめて、ではなく発見の都度):
  ${workdir}/findings.jsonl

**完了条件**: findings.jsonl に最低1件以上の entity を記録していない限り、このフェーズは未完了とみなす。
発見した資産(サブドメイン・サービス・アプリ・リポジトリ・メール・IP・エンドポイント等)は**漏れなく** entity として書くこと。
形式:
{"kind":"entity","type":"Domain|Subdomain|IP|Service|WebApp|Api|Endpoint|MobileApp|Artifact|TechStack|Secret|Org|CloudAsset|CodeRepo","value":"...","status":"live|deprecated|dead|abandoned|unknown","tags":["internal","staging","forgotten","dangling"...],"attrs":{...},"tool":"使った実コマンド","evidencePath":"evidence/op_XX.txt","confidence":0.0,"note":"..."}
{"kind":"edge","type":"derived_from","from":"<元の値>","to":"<派生した値>"}
{"kind":"hypothesis","statement":"調べる価値のある仮説","rationale":"根拠","targetValue":"<対象の値>","confidence":0.0}

作業の最後に必ず1行:
{"kind":"phase_complete","summary":"何をどれだけ見つけたか","covered":["調べた対象"]}

## ルール
- コマンド実行の結果は必ず ${workdir}/evidence/op_XX.txt に保存し、その finding の evidencePath で参照する(例: \`dig acme.com > ${workdir}/evidence/op_01.txt\`)。evidencePath は "evidence/op_XX.txt" のように workspace 相対で書くこと。
- 実際に実行した証拠の無い発見は書かない(捏造禁止)。
- 価値のある資産・痕跡だけ報告する。単なる 404/403/接続失敗やありふれた事実は書かない。
- 必要なツールが無ければ自分で導入してよい(brew/go install/pip 等)。導入もコマンドとして実行する。
`;
}

const ARSENAL_FOOTPRINT = `
## 使える手下(CLI。無ければ導入可)
- whois / dig : ドメイン・DNS情報
- curl + jq : crt.sh 証明書透明性ログ (https://crt.sh/?q=%25.<domain>&output=json) でサブドメイン列挙(失効分も)
- subfinder / amass : サブドメイン列挙
- httpx : 生存確認・statusCode・title・server header(live/dead 判定に使う)
- Web検索 : 組織のプロダクト・旧ブランド・モバイルアプリ・プレス・買収を発見
- (モバイル) Webやストア検索でアプリ名→package を特定
`;

const ARSENAL_ASSET = `
## 使える手下(CLI。無ければ導入可)
- apkeep / 各ストアミラー : package id を渡して APK を取得
- apktool / jadx : APK を逆コンパイル
- rg (ripgrep) : 逆コンパイル結果から endpoint・APIキー・内部ホストを grep
- curl / httpx : エンドポイントの到達性・挙動確認
- Web検索 : 仕様・旧バージョン・関連情報
`;

// 権限・防御目的の前提は agent.ts の SYSTEM_PROMPT として custom_agent_spec 経由で system レベル注入する
// (各 user メッセージに前置きするより拒否に強い)。

const DISPATCH_LOOP = `
進め方は「知る→翻訳→振る→取り込む」:
1. 知る: Web検索・推論・既存findingから手がかりを発見
2. 翻訳: 曖昧な情報をツールが食える正確な入力へ(例: アプリ名→package id)
3. 振る: 適切な手下(CLI)を正確な入力で実行
4. 取り込む: 出力を解釈し finding 化。新ホスト/ドメインは必ず出す(後で再調査される)
`;

export function footprintPrompt(seed: Entity, workdir: string): string {
  return `# フェーズ: Footprint Mapping(浅く広く・歴史的フットプリント)

対象: ${seed.type} "${seed.value}"

目的: この対象に紐づく「組織が外部に出した全資産」を、現役だけでなく過去(廃止・忘却)まで広く徹底収集する。
特に **誰も保守していない放置資産(status: dead / abandoned)** を見つけることに価値がある。

網羅する軸(カテゴリ × 時間):
- ドメイン/サブドメイン・IP / Webサービス・プロダクト / API / モバイルアプリ / コード・クラウド / 組織・人
- 各カテゴリで「現役(live)」と「歴史的(dead/deprecated/abandoned)」の両方を狙う

${DISPATCH_LOOP}
${ARSENAL_FOOTPRINT}
${outputContract(workdir)}`;
}

export function assetAnalysisPrompt(seed: Entity, workdir: string, direction?: string): string {
  return `# フェーズ: Asset Analysis(深掘り)

対象資産: ${seed.type} "${seed.value}"
既知の属性: ${JSON.stringify(seed.attrs)}
状態: ${seed.status} / タグ: ${seed.tags.join(",") || "-"}
${direction ? `狙う方向: ${direction}` : ""}

目的: この資産を「理解→仮説→検証」で深掘りする。
- 理解: 何か・役割・技術・現役か死んでるか
- 仮説: 調べる価値のある方向を根拠付きで複数立てる(hypothesis として書く)
- 検証: 各仮説を CLI/検索で確かめる
APK/モバイルアプリなら: package を特定 → APK取得 → jadx/apktool で逆コンパイル → rg で endpoint・APIキー・内部ホストを抽出。
見つけた新しいドメイン/ホスト/エンドポイント/秘密の痕跡は必ず findings に出す(新ドメインは Footprint へ自動で還流される)。

${DISPATCH_LOOP}
${ARSENAL_ASSET}
${outputContract(workdir)}`;
}

/** findings.jsonl に entity が1件も無いときの追いプロンプト */
export function repromptFindings(workdir: string): string {
  return `この防御的ASM作業の成果を構造化して記録する工程です。
これまでに収集した結果がまだ ${workdir}/findings.jsonl に記録されていません。

これまでに把握した資産・痕跡(サブドメイン・サービス・WebApp・API・モバイルアプリ・
リポジトリ・メール・IP・エンドポイント・露出の痕跡など)を、次の形式で ${workdir}/findings.jsonl に
1行1JSONで追記してください。新しいコマンドの実行は不要です。既に ${workdir}/evidence/ に保存した出力を根拠に書いてください。

{"kind":"entity","type":"...","value":"...","status":"live|deprecated|dead|abandoned|unknown","tags":[...],"attrs":{...},"tool":"...","evidencePath":"evidence/op_XX.txt","confidence":0.0,"note":"..."}

各 entity には必ず対応する evidencePath を付けること。最後に {"kind":"phase_complete","summary":"..."} を1行追記せよ。`;
}

export function synthesisPrompt(workdir: string): string {
  return `# フェーズ: Synthesis(統合・要約)

次の絶対パスのファイルを読み、調査結果を要約せよ:
  ${workdir}/findings.jsonl
要約は次の絶対パスに書き出すこと:
  ${workdir}/report/summary.md
含める内容:
1. エグゼクティブサマリ(5行程度)
2. 注目所見 Top5 — 特に status が dead / abandoned の「忘れられた資産」を優先し、なぜ重要か + 根拠(evidencePath)を添える
3. 推奨される次の調査ステップ

厳守: 新しい事実・数値・資産を捏造しない。findings.jsonl にある証拠付きの事実だけを参照する。
report/summary.md への書き込みが終わったら ${workdir}/findings.jsonl に {"kind":"phase_complete","summary":"report/summary.md を生成"} を追記せよ。`;
}
