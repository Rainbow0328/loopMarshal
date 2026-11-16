import type { FastifyBaseLogger } from "fastify";
import type { RouteServer } from "./route-types.js";
import type { DiscussionService } from "../services/discussion-service.js";
import { successResponse } from "./response.js";
import { z } from "zod";
import { coreErrors } from "../errors.js";

export function registerDiscussionRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  service: DiscussionService,
): void {
  const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success)
      throw coreErrors.invalidInput(
        "讨论请求不合法，请检查名称、成员或消息内容。",
      );
    return result.data;
  };
  server.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/discussions"))
      reply.header("Cache-Control", "no-store");
  });
  server.get("/api/discussions", async () => successResponse(service.list()));
  server.post("/api/discussions", async (request) => {
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          modelIds: z.array(z.string().min(1)).max(8).default([]),
          cliMembers: z
            .array(
              z
                .object({
                  installationId: z.string().min(1),
                  runtimeNamespace: z.string().max(2048).optional(),
                })
                .strict(),
            )
            .max(8)
            .default([]),
        })
        .strict(),
      request.body,
    );
    return successResponse(
      service.create(body.name, body.modelIds, body.cliMembers),
    );
  });
  server.get("/api/discussions/:roomId/messages", async (request) => {
    const query = parse(
      z.object({
        before: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      request.query,
    );
    return successResponse(
      service.messages(
        (request.params as { roomId: string }).roomId,
        query.before,
        query.limit,
      ),
    );
  });
  server.post("/api/discussions/:roomId/stop", async (request) => {
    service.cancel((request.params as { roomId: string }).roomId);
    return successResponse({ stopped: true });
  });
  server.get("/api/discussions/access/:sessionId", async (request) =>
    successResponse(
      service.grants((request.params as { sessionId: string }).sessionId),
    ),
  );
  server.put("/api/discussions/access/:sessionId/:roomId", async (request) => {
    const input = parse(
      z.object({ enabled: z.boolean() }).strict(),
      request.body,
    );
    const { sessionId, roomId } = request.params as {
      sessionId: string;
      roomId: string;
    };
    return successResponse(service.setGrant(sessionId, roomId, input.enabled));
  });
  server.post("/api/discussions/:roomId/messages", async (request) => {
    const body = (request.body ?? {}) as {
      content?: unknown;
      memberIds?: unknown;
    };
    return successResponse(
      await service.send(
        (request.params as { roomId: string }).roomId,
        body.content,
        body.memberIds,
      ),
    );
  });
  server.get("/api/discussions/:roomId/knowledge", async (request) =>
    successResponse(
      service.knowledge((request.params as { roomId: string }).roomId),
    ),
  );
  server.post("/api/discussions/:roomId/knowledge/draft", async (request) => {
    const body = (request.body ?? {}) as {
      modelId?: unknown;
      sourceIds?: unknown;
    };
    return successResponse(
      await service.draftKnowledge(
        (request.params as { roomId: string }).roomId,
        body.modelId,
        body.sourceIds,
      ),
    );
  });
  server.get(
    "/api/discussions/:roomId/knowledge/:entryId/sources",
    async (request) => {
      const { roomId, entryId } = request.params as {
        roomId: string;
        entryId: string;
      };
      return successResponse(service.knowledgeSources(roomId, entryId));
    },
  );
  server.post("/api/discussions/:roomId/knowledge", async (request) => {
    const body = (request.body ?? {}) as {
      title?: unknown;
      content?: unknown;
      sourceIds?: unknown;
    };
    return successResponse(
      service.saveKnowledge(
        (request.params as { roomId: string }).roomId,
        body.title,
        body.content,
        body.sourceIds,
      ),
    );
  });
}
