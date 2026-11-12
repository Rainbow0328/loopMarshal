import type { FastifyBaseLogger } from "fastify";
import type { BroadcastConsoleUpdate, RouteServer } from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import {
  attachSessionInputSchema,
  createSessionInputSchema,
  createSessionSetupSchema,
  discoverSessionsInputSchema,
  joinSessionByNameInputSchema,
  joinSessionInputSchema,
  removeSessionMemberInputSchema,
  updateSessionInsightInputSchema,
} from "@loopmarshal/protocol";

import { CoreError } from "../errors.js";
import { authorizeProxyRequest } from "./proxy-auth.js";
import { successResponse } from "./response.js";

export function registerSessionRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
): void {
  server.post("/api/sessions", async (request) => {
    const input = createSessionInputSchema.parse(request.body);
    const result = services.sessionService.createSession(input);
    services.managedAgentSetupService?.syncSession(result.session.id);
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse(result);
  });

  server.post("/api/sessions/setup", async (request) => {
    const parsed = createSessionSetupSchema.safeParse(request.body);
    if (!parsed.success)
      throw new CoreError(
        "INVALID_INPUT",
        parsed.error.issues.map((issue) => issue.message).join(" "),
      );
    const { createSessionSetup } = await import(
      "../services/session-setup-service.js"
    );
    const result = await createSessionSetup(services, parsed.data);
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse(result);
  });

  server.post("/api/sessions/attach", async (request) => {
    const input = attachSessionInputSchema.parse(request.body);
    const result = services.sessionService.attachSessionByName(input);
    services.managedAgentSetupService?.syncSession(result.session.id);
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse(result);
  });

  server.get("/api/sessions", async () => {
    return successResponse({
      sessions: services.sessionService.listSessions(),
    });
  });

  server.post("/api/sessions/discover", async (request) => {
    const input = discoverSessionsInputSchema.parse(request.body ?? {});
    const projectPath = input.projectPath
      ? services.sessionService.resolveProjectPath(input.projectPath)
      : null;
    const active = services.sessionService
      .listSessions()
      .filter((session) => session.status !== "closed");
    const sessions = active
      .filter(
        (session) =>
          !projectPath ||
          (session.projectPath &&
            services.sessionService.sameProjectPath(
              session.projectPath,
              projectPath,
            )),
      )
      .map((session) => {
        const host = services.sessionService
          .listMembers(session.id)
          .find(
            (agent) =>
              agent.id === session.hostAgentId && agent.role === "host",
          );
        if (!host) return null;
        const accessMode =
          services.memberRouteService?.get(session.id, host.id).route
            .accessMode ?? "cli_await";
        return {
          ...session,
          host: {
            id: host.id,
            agentName: host.agentName,
            displayName: host.displayName,
            platform: host.platform,
            accessMode,
          },
        };
      })
      .filter((session) => session !== null);
    return successResponse({
      sessions,
      projectPath,
      unassignedSessionCount: active.filter((session) => !session.projectPath)
        .length,
    });
  });

  server.get("/api/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse(
      services.sessionService.getSession(params.sessionId),
    );
  });

  server.get("/api/sessions/by-name/:sessionName", async (request) => {
    const params = request.params as { sessionName: string };
    return successResponse(
      services.sessionService.getSessionByName(params.sessionName),
    );
  });

  server.delete("/api/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { requesterAgentId?: string })
        : {};
    const result = body.requesterAgentId
      ? services.sessionService.deleteSession(
          params.sessionId,
          body.requesterAgentId,
        )
      : services.sessionService.deleteSession(params.sessionId);
    broadcastConsoleUpdate(params.sessionId, "member_changed");
    return successResponse(result);
  });

  server.delete("/api/sessions/by-name/:sessionName", async (request) => {
    const params = request.params as { sessionName: string };
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as { requesterAgentId?: string })
        : {};
    const targetSession = services.sessionService.getSessionByName(
      params.sessionName,
    );
    const result = body.requesterAgentId
      ? services.sessionService.deleteSessionByName(
          params.sessionName,
          body.requesterAgentId,
        )
      : services.sessionService.deleteSessionByName(params.sessionName);
    broadcastConsoleUpdate(targetSession.id, "member_changed");
    return successResponse(result);
  });

  server.post("/api/sessions/:sessionId/join", async (request) => {
    const params = request.params as { sessionId: string };
    const input = joinSessionInputSchema.parse({
      ...(request.body as Record<string, unknown>),
      sessionId: params.sessionId,
    });

    const result = services.sessionService.joinSession(input);
    services.managedAgentSetupService?.syncSession(result.session.id);
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse(result);
  });

  server.post("/api/sessions/join-by-name", async (request) => {
    const input = joinSessionByNameInputSchema.parse(request.body);
    const result = services.sessionService.joinSessionByName(input);
    services.managedAgentSetupService?.syncSession(result.session.id);
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse(result);
  });

  server.get("/api/sessions/:sessionId/members", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      members: services.sessionService.listMembers(params.sessionId),
    });
  });

  server.get("/api/sessions/:sessionId/heartbeats", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      heartbeats: services.sessionService.listMemberHeartbeats(
        params.sessionId,
      ),
    });
  });

  server.get("/api/sessions/:sessionId/insight", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      insight: services.sessionInsightService.getSessionInsight(
        params.sessionId,
      ),
    });
  });

  server.get("/api/sessions/:sessionId/console", async (request) => {
    const params = request.params as { sessionId: string };
    const console = services.sessionConsoleService.getSessionConsole(
      params.sessionId,
    );
    for (const member of console.members)
      member.automaticSetup =
        services.managedAgentSetupService?.read(
          params.sessionId,
          member.agentId,
        ) ?? null;
    return successResponse({
      console,
    });
  });

  server.post(
    "/api/sessions/:sessionId/agent-setups/refresh",
    async (request) => {
      if (services.proxyManagementTokenHash)
        authorizeProxyRequest(request, services.proxyManagementTokenHash);
      const { sessionId } = request.params as { sessionId: string };
      return successResponse({
        setups: services.managedAgentSetupService?.syncSession(sessionId) ?? [],
      });
    },
  );

  server.put("/api/sessions/:sessionId/insight", async (request) => {
    const params = request.params as { sessionId: string };
    const input = updateSessionInsightInputSchema.parse({
      ...(request.body as Record<string, unknown>),
      sessionId: params.sessionId,
    });

    return successResponse({
      insight: services.sessionInsightService.updateSessionInsight(input),
    });
  });

  server.post("/api/agents/:agentId/heartbeat", async (request) => {
    const params = request.params as { agentId: string };
    const members = services.sessionService
      .listSessions()
      .flatMap((session) => services.sessionService.listMembers(session.id));
    const member = members.find((agent) => agent.id === params.agentId);
    const result = services.agentService.heartbeat(params.agentId);
    if (member) {
      broadcastConsoleUpdate(member.sessionId, "member_changed");
    }
    return successResponse(result);
  });

  server.post("/api/agents/:agentId/leave", async (request) => {
    const params = request.params as { agentId: string };
    const result = services.agentService.leave(params.agentId);
    broadcastConsoleUpdate(result.sessionId, "member_changed");
    return successResponse(result);
  });

  server.post(
    "/api/sessions/:sessionId/members/:agentId/remove",
    async (request) => {
      const params = request.params as {
        sessionId: string;
        agentId: string;
      };
      const input = removeSessionMemberInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        sessionId: params.sessionId,
        targetAgentId: params.agentId,
      });

      const result = services.sessionService.removeSessionMember(input);
      broadcastConsoleUpdate(params.sessionId, "member_changed");
      return successResponse(result);
    },
  );
}
