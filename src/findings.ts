import { readFileSync } from "node:fs";

export type FindingKind = "entity" | "edge" | "hypothesis" | "phase_complete" | "triage";
export type AssetStatus = "live" | "deprecated" | "dead" | "abandoned" | "unknown";

export interface FindingRecord {
  kind: FindingKind;
  type?: string;
  value?: string;
  status?: AssetStatus;
  tags?: string[];
  attrs?: Record<string, unknown>;
  evidencePath?: string;
  tool?: string;
  confidence?: number;
  note?: string;
  // edge
  from?: string;
  to?: string;
  // hypothesis / triage
  statement?: string;
  rationale?: string;
  targetValue?: string;
  // phase_complete
  summary?: string;
  covered?: string[];
}

export interface Entity {
  id: string;        // type:value
  type: string;
  value: string;
  status: AssetStatus;
  tags: string[];
  attrs: Record<string, unknown>;
  evidencePath?: string;
  tool?: string;
  confidence: number;
  note?: string;
  firstSeenDepth: number;
  interest: number;
}

/** findings.jsonl を行単位で読み、sinceLine 以降の新規レコードだけ返す */
export function readDelta(path: string, sinceLine: number): { records: FindingRecord[]; newLine: number } {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return { records: [], newLine: sinceLine }; }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const fresh = lines.slice(sinceLine);
  const records: FindingRecord[] = [];
  for (const l of fresh) {
    try { records.push(JSON.parse(l)); } catch { /* 壊れた行は無視 */ }
  }
  return { records, newLine: lines.length };
}

const STATUS_SCORE: Record<AssetStatus, number> = {
  abandoned: 0.9, deprecated: 0.7, dead: 0.6, unknown: 0.4, live: 0.3,
};

/** 見落とし狙い: dead/abandoned/internal/staging を高く */
export function baseScore(e: Entity): number {
  let s = STATUS_SCORE[e.status] ?? 0.4;
  if (e.tags.includes("internal")) s += 0.3;
  if (e.tags.includes("staging")) s += 0.3;
  if (e.tags.includes("forgotten") || e.tags.includes("dangling")) s += 0.2;
  if (e.type === "Artifact" || e.type === "MobileApp") s += 0.2;
  if (e.type === "Api") s += 0.15;
  s += Math.min(e.firstSeenDepth * 0.05, 0.2);
  return Math.max(0, Math.min(1, s));
}

export class FindingsGraph {
  entities = new Map<string, Entity>();
  edges: FindingRecord[] = [];
  hypotheses: FindingRecord[] = [];

  /** records を取り込み、新規追加された Entity 配列を返す */
  merge(records: FindingRecord[], depth: number): Entity[] {
    const added: Entity[] = [];
    for (const r of records) {
      if (r.kind === "entity" && r.type && r.value) {
        const id = `${r.type}:${r.value.toLowerCase()}`;
        const existing = this.entities.get(id);
        if (!existing) {
          const e: Entity = {
            id, type: r.type, value: r.value,
            status: r.status ?? "unknown",
            tags: r.tags ?? [],
            attrs: r.attrs ?? {},
            evidencePath: r.evidencePath, tool: r.tool,
            confidence: r.confidence ?? 0.5,
            note: r.note,
            firstSeenDepth: depth,
            interest: 0,
          };
          e.interest = baseScore(e);
          this.entities.set(id, e);
          added.push(e);
        } else {
          // merge: tags 和集合・status は確度高い方・interest 最大
          existing.tags = Array.from(new Set([...existing.tags, ...(r.tags ?? [])]));
          if (r.status && r.status !== "unknown") existing.status = r.status;
          existing.interest = Math.max(existing.interest, baseScore(existing));
        }
      } else if (r.kind === "edge") {
        this.edges.push(r);
      } else if (r.kind === "hypothesis" || r.kind === "triage") {
        this.hypotheses.push(r);
      }
    }
    return added;
  }

  byStatus(...st: AssetStatus[]): Entity[] {
    return [...this.entities.values()].filter((e) => st.includes(e.status));
  }
  all(): Entity[] { return [...this.entities.values()]; }
}
