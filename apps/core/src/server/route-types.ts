import type { WsConsoleUpdateReason } from "@loopmarshal/protocol";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

export type RouteServer<Logger extends FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

export type BroadcastConsoleUpdate = (
  sessionId: string,
  reason: WsConsoleUpdateReason,
) => void;
export type AuthorizeSender = (
  request: FastifyRequest,
  sessionId: string,
  agentId: string,
  required: boolean,
) => void;
