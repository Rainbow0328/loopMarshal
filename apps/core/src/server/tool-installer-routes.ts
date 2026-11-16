import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { toolInstallRequestSchema } from "@loopmarshal/protocol";
import type { RouteServer } from "./route-types.js";
import type { ToolInstallerService } from "../services/tool-installer-service.js";
import { successResponse } from "./response.js";
import { coreErrors } from "../errors.js";

export function registerToolInstallerRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  service: ToolInstallerService,
) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success)
      throw coreErrors.invalidInput(
        "安装请求不合法，请检查所选工具和存储目录。",
      );
    return result.data;
  };
  server.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/tool-installer"))
      reply.header("Cache-Control", "no-store");
  });
  server.get("/api/tool-installer", async () =>
    successResponse(service.settings()),
  );
  server.put("/api/tool-installer/settings", async (request) => {
    const input = parse(
      z.object({ root: z.string().trim().min(1).max(2048) }).strict(),
      request.body,
    );
    return successResponse(service.saveRoot(input.root));
  });
  server.post("/api/tool-installer/jobs", async (request) =>
    successResponse(
      service.start(parse(toolInstallRequestSchema, request.body)),
    ),
  );
}
