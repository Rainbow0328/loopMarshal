import {
  createToolConfigProfileSchema,
  previewToolConfigSchema,
} from "@loopmarshal/protocol";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";
import { coreErrors } from "../errors.js";
import type { ToolConfigService } from "../services/tool-config-service.js";
import { successResponse } from "./response.js";

export function registerToolConfigRoutes<Logger extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  service: ToolConfigService,
): void {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw coreErrors.invalidInput("配置请求不合法。");
    return result.data;
  };
  server.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/tool-config"))
      reply.header("Cache-Control", "no-store");
  });
  server.get("/api/tool-config/discover", async () =>
    successResponse({
      candidates: service.discover(),
      defaults: service.defaults(),
    }),
  );
  server.get("/api/tool-config/profiles", async () =>
    successResponse({
      profiles: service.listProfiles(),
      defaults: service.defaults(),
    }),
  );
  server.post(
    "/api/tool-config/installations/:installationId/check",
    async (request) => {
      const { installationId } = request.params as { installationId: string };
      const input = parse(
        z.object({ endpoint: z.string().trim().max(2048).optional() }).strict(),
        request.body ?? {},
      );
      return successResponse(
        await service.checkInstallation(installationId, input.endpoint),
      );
    },
  );
  server.post("/api/tool-config/profiles", async (request) =>
    successResponse({
      profile: service.createProfile(
        parse(createToolConfigProfileSchema, request.body),
      ),
    }),
  );
  server.get(
    "/api/tool-config/profiles/:profileId/documents",
    async (request) =>
      successResponse({
        documents: service.documents(
          (request.params as { profileId: string }).profileId,
        ),
      }),
  );
  server.post("/api/tool-config/profiles/:profileId/preview", async (request) =>
    successResponse(
      service.preview(
        (request.params as { profileId: string }).profileId,
        parse(previewToolConfigSchema, request.body),
      ),
    ),
  );
  server.post("/api/tool-config/profiles/:profileId/apply", async (request) => {
    const input = parse(
      z.object({ previewId: z.string().uuid() }).strict(),
      request.body,
    );
    return successResponse(
      service.apply(
        (request.params as { profileId: string }).profileId,
        input.previewId,
      ),
    );
  });
  server.get("/api/tool-config/profiles/:profileId/backups", async (request) =>
    successResponse({
      backups: service.backups(
        (request.params as { profileId: string }).profileId,
      ),
    }),
  );
  server.post(
    "/api/tool-config/profiles/:profileId/backups/:backupId/restore",
    async (request) => {
      const { profileId, backupId } = request.params as {
        profileId: string;
        backupId: string;
      };
      return successResponse({
        documents: service.restore(profileId, backupId),
      });
    },
  );
}
