import type { AgentId, Identity } from "../types";

/** Parameters of one CouncilJob workflow instance. */
export type JobParams =
  | { kind: "mission"; missionId: number; identity: Identity }
  | { kind: "research"; jobId: number; identity: Identity; topic: string }
  | { kind: "design"; jobId: number; identity: Identity; description: string; mockupFileId?: string; repo?: string; maxIterations?: number }
  | { kind: "eval"; jobId: number; identity?: Identity; agents: AgentId[]; model?: string }
  | { kind: "reflect"; jobId: number; identity: Identity }
  | { kind: "scout"; jobId: number; identity: Identity };
