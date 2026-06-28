import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";
import type { FindingsGraph, Entity } from "./findings.js";

function table(entities: Entity[]): string {
  if (entities.length === 0) return "_(なし)_\n";
  let s = "| type | value | status | interest | tags | evidence |\n|---|---|---|---|---|---|\n";
  for (const e of entities.sort((a, b) => b.interest - a.interest)) {
    s += `| ${e.type} | ${e.value} | ${e.status} | ${e.interest.toFixed(2)} | ${e.tags.join(",")} | ${e.evidencePath ?? "-"} |\n`;
  }
  return s;
}

/** graph から決定的に Markdown レポートを生成(report/report.md) */
export function generateReport(ws: Workspace, graph: FindingsGraph, target: string): string {
  const all = graph.all();
  const forgotten = all.filter((e) => e.status === "dead" || e.status === "abandoned" || e.status === "deprecated");
  const byType: Record<string, number> = {};
  for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1;

  let md = `# kyumei 調査レポート: ${target}\n\n`;
  md += `- Run: ${ws.runId}\n- エンティティ総数: ${all.length}\n- 仮説: ${graph.hypotheses.length} / 関係: ${graph.edges.length}\n\n`;

  md += `## カテゴリ別件数\n\n`;
  md += Object.entries(byType).map(([t, n]) => `- ${t}: ${n}`).join("\n") + "\n\n";

  md += `## 🔦 忘れられた資産(dead / abandoned / deprecated)— 見落とし狙い\n\n`;
  md += table(forgotten) + "\n";

  md += `## 全資産インベントリ\n\n`;
  md += table(all) + "\n";

  if (graph.hypotheses.length > 0) {
    md += `## 調査仮説\n\n`;
    for (const h of graph.hypotheses) {
      md += `- **${h.statement ?? h.rationale}** → ${h.targetValue ?? "-"} _(根拠: ${h.rationale ?? "-"})_\n`;
    }
    md += "\n";
  }

  if (graph.edges.length > 0) {
    md += `## 発見の系譜(reflux)\n\n`;
    for (const e of graph.edges) md += `- ${e.from} → ${e.to} (${e.type})\n`;
    md += "\n";
  }

  // AIが書いた summary があれば差し込む
  const summaryPath = join(ws.reportDir, "summary.md");
  if (existsSync(summaryPath)) {
    md = `${readFileSync(summaryPath, "utf8")}\n\n---\n\n` + md;
  }

  const out = join(ws.reportDir, "report.md");
  writeFileSync(out, md);
  writeFileSync(join(ws.reportDir, "report.json"), JSON.stringify({
    target, runId: ws.runId, entities: all, edges: graph.edges, hypotheses: graph.hypotheses,
  }, null, 2));
  return out;
}
