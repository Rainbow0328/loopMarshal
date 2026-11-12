import type {
  NativeSessionBinding,
  ToolInstallation,
} from "./member-routes.js";

export type DeliveryState =
  | "queued"
  | "delivering"
  | "awaiting_result"
  | "completed"
  | "failed"
  | "blocked"
  | "unknown"
  | "cancelled"
  | "superseded";
export type ProxyTargetSnapshot = {
  binding: NativeSessionBinding;
  installation: ToolInstallation;
  nativeSessionKey: string;
};
export type ProxyDelivery = {
  id: string;
  sequence: number;
  messageId: string;
  sessionId: string;
  targetAgentId: string;
  replyToAgentId: string;
  bindingVersion: number;
  snapshot: ProxyTargetSnapshot;
  state: DeliveryState;
  attemptId: string | null;
  ownerId: string | null;
  resultMessageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryEvent = {
  sequence: number;
  deliveryId: string;
  attemptId: string | null;
  type: string;
  payload: unknown;
  createdAt: string;
};
export type MemberActivity = {
  agentId: string;
  queued: number;
  running: number;
  blocked: number;
  unknown: number;
  lastFailure?: string | null;
};
