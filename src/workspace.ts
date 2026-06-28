import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Workspace {
  runId: string;
  dir: string;
  findingsPath: string;
  evidenceDir: string;
  artifactsDir: string;
  reportDir: string;
  auditPath: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 32);
}

export function createWorkspace(target: string, baseDir = ".kyumei/runs"): Workspace {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${ts}_${slug(target)}`;
  const dir = resolve(baseDir, runId);
  const evidenceDir = join(dir, "evidence");
  const artifactsDir = join(dir, "artifacts");
  const reportDir = join(dir, "report");
  for (const d of [dir, evidenceDir, artifactsDir, reportDir]) mkdirSync(d, { recursive: true });

  const findingsPath = join(dir, "findings.jsonl");
  const auditPath = join(dir, "audit.log");
  writeFileSync(findingsPath, "");
  writeFileSync(auditPath, "");

  return { runId, dir, findingsPath, evidenceDir, artifactsDir, reportDir, auditPath };
}

export function audit(ws: Workspace, event: Record<string, unknown>): void {
  appendFileSync(ws.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}
