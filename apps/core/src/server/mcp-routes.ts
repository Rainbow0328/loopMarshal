import type { FastifyBaseLogger } from "fastify";
import type {
  AuthorizeSender,
  BroadcastConsoleUpdate,
  RouteServer,
} from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import type {
  CreateMcpServerInput,
  McpToolsetId,
  UpdateMcpServerInput,
} from "@loopmarshal/protocol";

import { CoreError } from "../errors.js";
import { managedToolNames } from "../services/managed-collaboration-skill.js";
import { authorizeProxyRequest, memberBearer } from "./proxy-auth.js";
import { successResponse } from "./response.js";

export function registerMcpRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
  authorizeSender: AuthorizeSender,
): void {
  server.get("/api/mcp/tools", async (request) => {
    const query = request.query as {
      toolsetId?: string;
      extraToolNames?: string;
    };
    const toolsetId = (query.toolsetId ?? "worker") as McpToolsetId;
    const extraToolNames = query.extraToolNames
      ? query.extraToolNames
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    return successResponse({
      tools: [
        ...services.mcpToolService.getToolsetDefinitions(toolsetId),
        ...services.mcpToolService.getToolDefinitionsByNames(extraToolNames),
      ],
    });
  });

  server.post("/api/mcp/call", async (request) => {
    const body = request.body as {
      agentId: string;
      sessionId: string;
      toolName: string;
      arguments?: Record<string, unknown>;
    };
    if (memberBearer(request) !== null) {
      const credential = services.memberCredentialService!.authenticate(
        memberBearer(request)!,
      );
      const executionTools = [
        "session_context",
        "query_messages",
        "discussion_read",
        "knowledge_list",
        "knowledge_read",
        "knowledge_update",
        "update_insight",
        "file_read",
        "file_list",
      ];
      const managed = credential.label === "managed-agent:collaboration";
      if (managed) {
        const member = services.memberRouteService!.get(
          credential.sessionId,
          credential.agentId,
        );
        if (
          !managedToolNames(
            member.agent.role,
            member.route.accessMode,
          ).includes(body.toolName)
        )
          throw new CoreError(
            "PERMISSION_DENIED",
            "This tool is not enabled for the managed member.",
            403,
          );
      } else if (
        !["dispatch_task", "send_message"].includes(body.toolName) &&
        !(
          credential.label.startsWith("proxy-execution:") &&
          executionTools.includes(body.toolName)
        )
      )
        throw new CoreError(
          "PERMISSION_DENIED",
          "This credential does not authorize that tool.",
          403,
        );
      authorizeSender(request, body.sessionId, body.agentId, true);
    } else if (
      services.proxyManagementTokenHash &&
      ["dispatch_task", "send_message"].includes(body.toolName)
    ) {
      const targetId = body.arguments?.toAgentId;
      if (
        [body.agentId, targetId].some(
          (id) =>
            typeof id === "string" &&
            services.memberRouteService?.get(body.sessionId, id).route
              .accessMode === "managed_proxy",
        )
      ) {
        authorizeProxyRequest(request, services.proxyManagementTokenHash);
      }
    }
    const result = await services.mcpToolService.executeTool(
      body.toolName,
      body.arguments ?? {},
      body.agentId,
      body.sessionId,
      services,
    );
    if (
      result.success &&
      [
        "resolve_message",
        "claim_next",
        "send_message",
        "dispatch_task",
      ].includes(body.toolName)
    ) {
      broadcastConsoleUpdate(
        body.sessionId,
        body.toolName === "claim_next"
          ? "message_claimed"
          : body.toolName === "resolve_message"
            ? "message_completed"
            : "message_sent",
      );
    }
    return successResponse(result);
  });

  server.get("/api/mcp-servers", async () => {
    const servers = await Promise.all(
      services.externalMcpService.list().map(async (serverConfig) => ({
        ...serverConfig,
        toolCount: (
          await services.externalMcpService.listTools(serverConfig.id)
        ).length,
      })),
    );
    return successResponse(servers);
  });

  server.post("/api/mcp-servers", async (request) => {
    const body = request.body as CreateMcpServerInput & { enabled?: boolean };
    const created = services.externalMcpService.create({
      ...body,
      transport: body.transport ?? "sse",
    });
    if (body.enabled === false) {
      return successResponse(
        services.externalMcpService.update(created.id, { enabled: false }),
      );
    }
    return successResponse(created);
  });

  server.put("/api/mcp-servers/:serverId", async (request) => {
    const params = request.params as { serverId: string };
    return successResponse(
      services.externalMcpService.update(
        params.serverId,
        request.body as UpdateMcpServerInput,
      ),
    );
  });

  server.delete("/api/mcp-servers/:serverId", async (request) => {
    const params = request.params as { serverId: string };
    return successResponse(services.externalMcpService.delete(params.serverId));
  });

  server.get("/api/mcp-servers/:serverId/tools", async (request) => {
    const params = request.params as { serverId: string };
    return successResponse(
      await services.externalMcpService.listTools(params.serverId),
    );
  });

  server.get("/api/agent-profiles", async () => {
    return successResponse([]);
  });

  server.get("/api/agent-profiles/:profileId", async (request) => {
    const params = request.params as { profileId: string };
    throw new CoreError(
      "INVALID_INPUT",
      `Agent profile "${params.profileId}" is disabled in this build.`,
      404,
    );
  });

  server.get("/api/skills", async () => {
    return successResponse([]);
  });

  server.get("/api/skills/:skillId", async (request) => {
    const params = request.params as { skillId: string };
    throw new CoreError(
      "INVALID_INPUT",
      `Skill "${params.skillId}" is disabled in this build.`,
      404,
    );
  });

  server.get("/api/metrics", async (request) => {
    const params = request.query as { sessionId?: string };
    const metrics: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      websocketConnections: services.websocketService.getConnectionCount(),
      websocketStats: services.websocketService.getConnectionStats(),
    };

    if (params.sessionId) {
      metrics.sessionId = params.sessionId;
      metrics.sessionWebsocketConnections =
        services.websocketService.getSessionConnectionCount(params.sessionId);
    }

    return successResponse(metrics);
  });

  // --- stdio MCP server lifecycle API ---

  server.post("/api/mcp-stdio/register", async (request) => {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { pid?: number; ideLabel?: string })
        : {};
    const pid = Number(body.pid ?? process.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new CoreError("INVALID_INPUT", "Valid pid is required.");
    }
    const registration = services.stdioMcpRegistryService.register(
      pid,
      body.ideLabel,
    );
    return successResponse({ registration });
  });

  server.post("/api/mcp-stdio/heartbeat", async (request) => {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { pid?: number })
        : {};
    const pid = Number(body.pid ?? process.pid);
    const ok = services.stdioMcpRegistryService.heartbeat(pid);
    return successResponse({ ok });
  });

  server.delete("/api/mcp-stdio/unregister", async (request) => {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { pid?: number })
        : {};
    const pid = Number(body.pid ?? process.pid);
    const ok = services.stdioMcpRegistryService.unregister(pid);
    return successResponse({ ok });
  });

  server.get("/api/mcp-stdio/list", async () => {
    // Prune dead entries before returning
    services.stdioMcpRegistryService.pruneDeadProcesses((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    return successResponse({
      servers: services.stdioMcpRegistryService.list(),
    });
  });
}
