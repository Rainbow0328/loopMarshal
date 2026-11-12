import {
  createProxyMemberInputSchema,
  createToolInstallationInputSchema,
  updateMemberRouteInputSchema,
} from "@loopmarshal/protocol";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { z } from "zod";
import { z as schema } from "zod";
import { coreErrors } from "../errors.js";
import type { MemberRouteService } from "../services/member-route-service.js";
import { successResponse } from "./response.js";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw coreErrors.invalidInput(result.error.message);
  return result.data;
}

export function registerMemberRouteRoutes<Logger extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  service: MemberRouteService,
  notify: (sessionId: string) => void = () => {},
): void {
  server.get("/api/tool-installations", async () =>
    successResponse({ installations: service.listInstallations() }),
  );
  server.post("/api/tool-installations", async (request) =>
    successResponse({
      installation: service.createInstallation(
        parse(createToolInstallationInputSchema, request.body),
      ),
    }),
  );
  server.patch("/api/tool-installations/:installationId", async (request) => {
    const { installationId } = request.params as { installationId: string };
    return successResponse({
      installation: service.updateInstallation(installationId, request.body),
    });
  });
  server.get(
    "/api/tool-installations/:installationId/native-sessions",
    async (request) => {
      const { installationId } = request.params as { installationId: string };
      const query = parse(
        schema
          .object({
            workspacePath: schema.string().trim().min(1),
            runtimeNamespace: schema.string().trim().default(""),
          })
          .strict(),
        request.query,
      );
      return successResponse(
        service.discoverNativeSessions(
          installationId,
          query.workspacePath,
          query.runtimeNamespace ?? "",
        ),
      );
    },
  );
  server.get("/api/sessions/:sessionId/member-routes", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return successResponse({ members: service.list(sessionId) });
  });
  server.post("/api/sessions/:sessionId/proxy-members", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const member = service.createProxyMember(
      sessionId,
      parse(createProxyMemberInputSchema, request.body),
    );
    notify(sessionId);
    return successResponse({ member });
  });
  server.post(
    "/api/sessions/:sessionId/member-routes/await-members",
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const input = parse(
        schema
          .object({
            agentName: schema.string().trim().min(1).max(120),
            roleDescription: schema.string().trim().min(1).max(4000),
            role: schema.enum(["worker", "knowledge_keeper"]).default("worker"),
            accessMode: schema.enum(["mcp_await", "cli_await"]),
          })
          .strict(),
        request.body,
      );
      const member = service.createAwaitMember(sessionId, {
        agentName: input.agentName,
        roleDescription: input.roleDescription,
        accessMode: input.accessMode,
        ...(input.role ? { role: input.role } : {}),
      });
      notify(sessionId);
      return successResponse({ member });
    },
  );
  server.put(
    "/api/sessions/:sessionId/member-routes/:agentId",
    async (request) => {
      const { sessionId, agentId } = request.params as {
        sessionId: string;
        agentId: string;
      };
      const member = service.update(
        sessionId,
        agentId,
        parse(updateMemberRouteInputSchema, request.body),
      );
      notify(sessionId);
      return successResponse({ member });
    },
  );
  server.post(
    "/api/sessions/:sessionId/member-routes/:agentId/retry-create",
    async (request) => {
      const { sessionId, agentId } = request.params as {
        sessionId: string;
        agentId: string;
      };
      const input = parse(
        schema
          .object({ expectedBindingVersion: schema.number().int().positive() })
          .strict(),
        request.body,
      );
      const member = service.retryNativeSessionCreation(
        sessionId,
        agentId,
        input.expectedBindingVersion,
      );
      notify(sessionId);
      return successResponse({ member });
    },
  );
  server.get(
    "/api/sessions/:sessionId/member-routes/:agentId/events",
    async (request) => {
      const { sessionId, agentId } = request.params as {
        sessionId: string;
        agentId: string;
      };
      return successResponse({
        events: service.listEvents(sessionId, agentId),
      });
    },
  );
}
