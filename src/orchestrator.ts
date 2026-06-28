import type { Agent } from "./agent.js";
import type { KyumeiConfig } from "./config.js";
import type { Workspace } from "./workspace.js";
import { audit } from "./workspace.js";
import { FindingsGraph, readDelta, type Entity } from "./findings.js";
import { footprintPrompt, assetAnalysisPrompt, synthesisPrompt, repromptFindings, type PhaseId } from "./phases.js";

interface Task {
  phase: PhaseId;
  seed: Entity;
  depth: number;
  score: number;
}

const DEEPEN_TYPES = new Set(["MobileApp", "Api", "WebApp", "Artifact", "Service", "CloudAsset", "CodeRepo"]);
const FOOTPRINT_TYPES = new Set(["Domain", "Subdomain", "Org"]);

/** 新エンティティ e に対して走らせるべきフェーズ */
function phasesFor(e: Entity): PhaseId[] {
  if (DEEPEN_TYPES.has(e.type)) return ["assetAnalysis"];
  // dead/abandoned のサブドメインは深掘り対象にもする(テイクオーバー兆候など)
  if (e.type === "Subdomain" && (e.status === "dead" || e.status === "abandoned")) return ["footprint", "assetAnalysis"];
  if (FOOTPRINT_TYPES.has(e.type)) return ["footprint"];
  return [];
}

function buildPrompt(task: Task, workdir: string): string {
  switch (task.phase) {
    case "footprint": return footprintPrompt(task.seed, workdir);
    case "assetAnalysis": return assetAnalysisPrompt(task.seed, workdir);
    case "synthesis": return synthesisPrompt(workdir);
  }
}

export async function orchestrate(
  ws: Workspace,
  agent: Agent,
  cfg: KyumeiConfig,
  target: string,
  log: (s: string) => void,
): Promise<FindingsGraph> {
  const graph = new FindingsGraph();
  const targetEntity: Entity = {
    id: `Target:${target}`, type: "Target", value: target, status: "unknown",
    tags: [], attrs: {}, confidence: 1, firstSeenDepth: 0, interest: 1,
  };

  const frontier: Task[] = [{ phase: "footprint", seed: targetEntity, depth: 0, score: 1 }];
  const explored = new Set<string>();
  let line = 0;
  let tasks = 0;

  while (frontier.length > 0 && tasks < cfg.maxTasks) {
    // breadth(footprint)を浅さ優先で先に、deepeningはscore順
    frontier.sort((a, b) => {
      const pa = a.phase === "footprint" ? 1 : 0;
      const pb = b.phase === "footprint" ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (a.phase === "footprint") return a.depth - b.depth;
      return b.score - a.score;
    });

    const task = frontier.shift()!;
    const key = `${task.phase}:${task.seed.value}`;
    if (explored.has(key)) continue;
    explored.add(key);

    tasks++;
    log(`▶ [${tasks}] ${task.phase}  ${task.seed.type}:${task.seed.value}  (depth=${task.depth})`);
    audit(ws, { t: "phase_start", phase: task.phase, seed: task.seed.value, depth: task.depth });

    try {
      await agent.run(buildPrompt(task, ws.dir), { model: cfg.model, timeoutMs: cfg.phaseTimeoutMs });
    } catch (e) {
      log(`  ! フェーズ失敗: ${String(e)}`);
      audit(ws, { t: "phase_error", phase: task.phase, seed: task.seed.value, error: String(e) });
      continue;
    }

    let { records, newLine } = readDelta(ws.findingsPath, line);
    line = newLine;
    let added = graph.merge(records, task.depth + 1);

    // findings強制: entity が0件なら1回だけ追いプロンプトで記録させる(doc04.5の網羅チェック簡易版)
    if (records.filter((r) => r.kind === "entity").length === 0) {
      log(`  ⟳ findings未記録 → 追いプロンプトで収集結果の記録を要求`);
      audit(ws, { t: "reprompt", phase: task.phase, seed: task.seed.value, reason: "no_entities" });
      try {
        await agent.run(repromptFindings(ws.dir), { model: cfg.model, timeoutMs: cfg.phaseTimeoutMs });
        const d2 = readDelta(ws.findingsPath, line);
        line = d2.newLine;
        added = added.concat(graph.merge(d2.records, task.depth + 1));
      } catch (e) {
        log(`  ! reprompt失敗: ${String(e)}`);
      }
    }
    log(`  + 新規エンティティ ${added.length} 件`);
    audit(ws, { t: "phase_end", phase: task.phase, seed: task.seed.value, added: added.length });

    // フォローアップ生成(reflux)
    for (const e of added) {
      if (task.depth + 1 > cfg.maxDepth) continue;
      for (const ph of phasesFor(e)) {
        const k = `${ph}:${e.value}`;
        if (explored.has(k)) continue;
        frontier.push({ phase: ph, seed: e, depth: task.depth + 1, score: e.interest });
      }
    }

    // 深掘りは triageTopK 件に絞る(価値の高い順に予算集中)
    const deepen = frontier.filter((t) => t.phase === "assetAnalysis").sort((a, b) => b.score - a.score);
    const drop = deepen.slice(cfg.triageTopK);
    for (const d of drop) {
      const i = frontier.indexOf(d);
      if (i >= 0) frontier.splice(i, 1);
    }
  }

  // 終端: Synthesis
  log("▶ synthesis(レポート生成)");
  audit(ws, { t: "phase_start", phase: "synthesis" });
  try {
    await agent.run(synthesisPrompt(ws.dir), { model: cfg.model, timeoutMs: cfg.phaseTimeoutMs });
    const { records, newLine } = readDelta(ws.findingsPath, line);
    line = newLine;
    graph.merge(records, 0);
  } catch (e) {
    log(`  ! synthesis 失敗: ${String(e)}`);
  }

  return graph;
}
