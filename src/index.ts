#!/usr/bin/env tsx
import { DEFAULT_CONFIG, type KyumeiConfig } from "./config.js";
import { createWorkspace, audit } from "./workspace.js";
import { AntigravityAgent, MockAgent, type Agent } from "./agent.js";
import { orchestrate } from "./orchestrator.js";
import { generateReport } from "./report.js";
import { readDelta } from "./findings.js";

function parseArgs(argv: string[]): { cmd: string; target?: string; cfg: KyumeiConfig } {
  const cfg: KyumeiConfig = { ...DEFAULT_CONFIG };
  const args = argv.slice(2);
  const cmd = args[0] ?? "help";
  let target: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--mock") cfg.mock = true;
    else if (a === "--model") { const v = args[++i]; cfg.model = /^\d+$/.test(v) ? Number(v) : v; }
    else if (a === "--max-depth") cfg.maxDepth = Number(args[++i]);
    else if (a === "--max-tasks") cfg.maxTasks = Number(args[++i]);
    else if (a === "--top-k") cfg.triageTopK = Number(args[++i]);
    else if (!a.startsWith("--")) target = a;
  }
  return { cmd, target, cfg };
}

const HELP = `kyumei — AI支援型インフラ調査 PoC

使い方:
  npm run kyumei -- run <target> [options]
  npm run kyumei -- smoke           # 外部を叩かずに本番経路(Antigravity接続〜コマンド承認〜findings書込)を検証

options:
  --mock           LLM不要のモックで配管検証(Antigravity接続なし)
  --model <id>     使用モデル名 or 数値ID (default: 1018)
  --max-depth <n>  reflux深さ上限 (default: 2)
  --max-tasks <n>  Task総数上限 (default: 12)
  --top-k <n>      深掘り優先実行数 (default: 3)

例:
  npm run kyumei -- run example.com --mock   # 配管(reflux/レポート)
  npm run kyumei -- smoke                     # AI+CLI実結線の安全テスト
  npm run kyumei -- run scanme.nmap.org       # 許可された対象で本番
`;

function smokePrompt(workdir: string): string {
  return `これは kyumei の接続確認テストです。**外部ネットワークへの通信は一切行わないでください。**

次のローカルコマンドだけを実行してください(絶対パスで完結):
  echo "kyumei integration ok" > ${workdir}/evidence/op_smoke.txt

その後、次の絶対パスのファイルに次の2行を追記してください(1行1JSON):
  ${workdir}/findings.jsonl
{"kind":"entity","type":"TechStack","value":"kyumei-smoke-test","status":"live","tool":"echo","evidencePath":"evidence/op_smoke.txt","confidence":1.0,"note":"integration smoke"}
{"kind":"phase_complete","summary":"smoke ok"}
`;
}

async function smoke(cfg: KyumeiConfig) {
  const ws = createWorkspace("smoke-test");
  console.log(`kyumei smoke (runId=${ws.runId}, model=${cfg.model})`);
  console.log(`workspace: ${ws.dir}\n`);
  const agent = new AntigravityAgent(ws, (t) => process.stdout.write(t));
  try {
    await agent.start();
    console.log("✓ Antigravity 接続OK。テストプロンプト送信中...\n");
    await agent.run(smokePrompt(ws.dir), { model: cfg.model, timeoutMs: 120_000 });
    await agent.dispose();
  } catch (e) {
    console.error(`\n✗ 接続/実行に失敗: ${String(e)}`);
    process.exit(2);
  }
  const { records } = readDelta(ws.findingsPath, 0);
  const ok = records.some((r) => r.value === "kyumei-smoke-test");
  console.log(ok
    ? `\n✓ smoke 成功: findings.jsonl に書き込み確認。本番経路(接続・承認・出力契約)は機能しています。`
    : `\n△ 接続はできたが findings.jsonl に期待の行がありません。プロンプト/出力契約を確認してください。\n  findings: ${ws.findingsPath}`);
  process.exit(ok ? 0 : 1);
}

/** "https://miria-tech.jp/path" → "miria-tech.jp" のように対象を正規化 */
function normalizeTarget(t: string): string {
  return t.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "").replace(/\.$/, "").trim().toLowerCase();
}

async function main() {
  const { cmd, target: rawTarget, cfg } = parseArgs(process.argv);
  if (cmd === "smoke") { await smoke(cfg); return; }
  if (cmd !== "run" || !rawTarget) { console.log(HELP); process.exit(cmd === "help" ? 0 : 1); }
  const target = normalizeTarget(rawTarget!);

  const ws = createWorkspace(target);
  const log = (s: string) => console.log(s);
  log(`kyumei run: ${target}  (runId=${ws.runId}, mock=${cfg.mock})`);
  log(`workspace: ${ws.dir}\n`);
  audit(ws, { t: "run_start", target, cfg });

  const agent: Agent = cfg.mock ? new MockAgent(ws) : new AntigravityAgent(ws, (t) => process.stdout.write(t));

  try {
    await agent.start();
  } catch (e) {
    console.error(`\n接続失敗: ${String(e)}`);
    console.error("→ Antigravity 未導入/未起動の可能性。配管確認には --mock を使ってください。");
    process.exit(2);
  }

  const graph = await orchestrate(ws, agent, cfg, target!, log);
  await agent.dispose();

  const reportPath = generateReport(ws, graph, target!);
  const forgotten = graph.all().filter((e) => ["dead", "abandoned", "deprecated"].includes(e.status)).length;
  log(`\n✓ 完了: エンティティ ${graph.all().length} 件(うち忘れられた資産 ${forgotten} 件)`);
  log(`  レポート: ${reportPath}`);
  audit(ws, { t: "run_done", entities: graph.all().length });
}

main().catch((e) => { console.error(e); process.exit(1); });
