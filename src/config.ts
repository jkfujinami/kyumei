export interface KyumeiConfig {
  model: string | number;  // モデル名 or 数値ID(例: 1018)
  maxDepth: number;     // reflux 深さ上限
  maxTasks: number;     // Run全体のTask上限(暴走防止)
  triageTopK: number;   // 深掘りを優先実行する上位数
  phaseTimeoutMs: number;
  mock: boolean;
}

export const DEFAULT_CONFIG: KyumeiConfig = {
  model: 1018,
  maxDepth: 2,
  maxTasks: 12,
  triageTopK: 3,
  phaseTimeoutMs: 600_000,
  mock: false,
};
