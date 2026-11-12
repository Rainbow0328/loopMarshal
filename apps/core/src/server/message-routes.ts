import type { FastifyBaseLogger } from "fastify";
import type {
  AuthorizeSender,
  BroadcastConsoleUpdate,
  RouteServer,
} from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import {
  acquireIdentityLeaseInputSchema,
  messageClaimInputSchema,
  messageProcessCompleteInputSchema,
  messageProcessFailInputSchema,
  namedSendInputSchema,
  releaseIdentityLeaseInputSchema,
  sendMessageInputSchema,
  updateWindowBindingDefaultsInputSchema,
  updateWindowRuntimeStateInputSchema,
  type SendMessageInput,
} from "@loopmarshal/protocol";

import { CoreError } from "../errors.js";
import { successResponse } from "./response.js";

export function registerMessageRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
  authorizeSender: AuthorizeSender,
): void {
  server.post("/api/messages/send", async (request) => {
    const parsed = sendMessageInputSchema.parse(request.body);
    authorizeSender(
      request,
      parsed.sessionId,
      parsed.fromAgentId,
      [parsed.fromAgentId, parsed.toAgentId].some((id) =>
        Boolean(
          id &&
            services.memberRouteService?.get(parsed.sessionId, id).route
              .accessMode === "managed_proxy",
        ),
      ),
    );
    const input: SendMessageInput = {
      sessionId: parsed.sessionId,
      fromAgentId: parsed.fromAgentId,
      type: parsed.type,
      payload: parsed.payload,
      ...(parsed.toAgentId ? { toAgentId: parsed.toAgentId } : {}),
      ...(parsed.idempotencyKey
        ? { idempotencyKey: parsed.idempotencyKey }
        : {}),
      ...(parsed.correlationId ? { correlationId: parsed.correlationId } : {}),
      ...(parsed.supersedeMessageIds
        ? { supersedeMessageIds: parsed.supersedeMessageIds }
        : {}),
    };
    const message = services.messageService.sendMessage(input);
    broadcastConsoleUpdate(message.sessionId, "message_sent");
    return successResponse(message);
  });

  server.post("/api/messages/send-by-name", async (request) => {
    const parsed = namedSendInputSchema.safeParse(request.body);
    if (!parsed.success)
      throw new CoreError("INVALID_INPUT", parsed.error.message);
    const session = services.sessionService.getSessionByName(
      parsed.data.sessionName,
    );
    const sender = services.sessionService
      .listMembers(session.id)
      .find((member) => member.agentName === parsed.data.from);
    if (!sender)
      throw new CoreError("INVALID_INPUT", "Sending member was not found.");
    authorizeSender(request, session.id, sender.id, true);
    const messages = services.messageService.sendByName(parsed.data);
    for (const message of messages)
      broadcastConsoleUpdate(message.sessionId, "message_sent");
    return successResponse({ messages });
  });

  server.post("/api/identity-leases/acquire", async (request) => {
    const input = acquireIdentityLeaseInputSchema.parse(request.body);
    return successResponse({
      lease: services.identityLeaseService.acquire(input),
    });
  });

  server.post("/api/identity-leases/release", async (request) => {
    const input = releaseIdentityLeaseInputSchema.parse(request.body);
    return successResponse(services.identityLeaseService.release(input));
  });

  server.get("/api/window-bindings", async (request) => {
    const query = request.query as {
      sessionName?: string;
    };
    return successResponse({
      bindings: services.windowBindingService.list(query.sessionName),
    });
  });

  server.get(
    "/api/window-bindings/:sessionName/:windowName",
    async (request) => {
      const params = request.params as {
        sessionName: string;
        windowName: string;
      };
      return successResponse({
        binding: services.windowBindingService.get(
          params.sessionName,
          params.windowName,
        ),
      });
    },
  );

  server.put(
    "/api/window-bindings/:sessionName/:windowName/defaults",
    async (request) => {
      const params = request.params as {
        sessionName: string;
        windowName: string;
      };
      const input = updateWindowBindingDefaultsInputSchema.parse(request.body);
      return successResponse({
        binding: services.windowBindingService.updateDefaults(
          params.sessionName,
          params.windowName,
          input,
        ),
      });
    },
  );

  server.put(
    "/api/window-bindings/:sessionName/:windowName/runtime",
    async (request) => {
      const params = request.params as {
        sessionName: string;
        windowName: string;
      };
      const input = updateWindowRuntimeStateInputSchema.parse(request.body);
      return successResponse({
        binding: services.windowBindingService.updateRuntimeState(
          params.sessionName,
          params.windowName,
          input,
        ),
      });
    },
  );

  server.delete(
    "/api/window-bindings/:sessionName/:windowName/runtime",
    async (request) => {
      const params = request.params as {
        sessionName: string;
        windowName: string;
      };
      return successResponse({
        binding: services.windowBindingService.clearRuntimeState(
          params.sessionName,
          params.windowName,
        ),
      });
    },
  );

  server.get("/api/messages/:messageId", async (request) => {
    const params = request.params as { messageId: string };
    return successResponse({
      message: services.messageService.getMessage(params.messageId),
    });
  });

  server.get("/api/agents/:agentId/inbox", async (request) => {
    const params = request.params as { agentId: string };
    const query = request.query as {
      pendingOnly?: string;
      claimedOnly?: string;
    };
    return successResponse({
      messages: services.messageService.getInbox(params.agentId, {
        pendingOnly: query.pendingOnly === "true",
        claimedOnly: query.claimedOnly === "true",
      }),
    });
  });

  server.get("/api/sessions/:sessionId/messages", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      messages: services.messageService.listMessagesBySession(params.sessionId),
    });
  });

  server.get("/api/sessions/:sessionId/queue-stats", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      agents: services.messageService.getSessionQueueStats(params.sessionId),
    });
  });

  server.post("/api/messages/claim-next", async (request) => {
    const input = messageClaimInputSchema.parse(request.body);
    const message = services.messageService.claimNext(input.agentId, {
      ...(input.types ? { types: input.types } : {}),
      ...(input.fromAgentId ? { fromAgentId: input.fromAgentId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
      ...(input.flow ? { flow: input.flow } : {}),
      ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
    });
    if (message) {
      broadcastConsoleUpdate(message.sessionId, "message_claimed");
    }
    return successResponse({
      message,
    });
  });

  server.post("/api/messages/:messageId/ack", async (request) => {
    const params = request.params as { messageId: string };
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { processed?: boolean })
        : {};

    return successResponse(
      services.messageService.acknowledge(
        params.messageId,
        body.processed ?? false,
      ),
    );
  });

  server.post("/api/messages/:messageId/process-complete", async (request) => {
    const params = request.params as { messageId: string };
    const input = messageProcessCompleteInputSchema.parse(request.body);
    const message = services.messageService.completeMessage(
      params.messageId,
      input.agentId,
      {
        ...(input.identity ? { identity: input.identity } : {}),
        ...(input.flow ? { flow: input.flow } : {}),
        ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
      },
    );
    broadcastConsoleUpdate(message.sessionId, "message_completed");
    return successResponse({
      message,
    });
  });

  server.post("/api/messages/:messageId/process-fail", async (request) => {
    const params = request.params as { messageId: string };
    const input = messageProcessFailInputSchema.parse(request.body);
    const message = services.messageService.failMessage(
      params.messageId,
      input.agentId,
      input.reason,
      {
        ...(input.identity ? { identity: input.identity } : {}),
        ...(input.flow ? { flow: input.flow } : {}),
        ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
      },
    );
    broadcastConsoleUpdate(message.sessionId, "message_completed");
    return successResponse({
      message,
    });
  });
}
