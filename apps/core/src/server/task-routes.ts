import type { FastifyBaseLogger } from "fastify";
import type { BroadcastConsoleUpdate, RouteServer } from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import {
  completeTaskInputSchema,
  createTaskInputSchema,
  listProgressFilterSchema,
  upsertProgressInputSchema,
} from "@loopmarshal/protocol";

import { successResponse } from "./response.js";

export function registerTaskRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
): void {
  server.post("/api/tasks", async (request) => {
    const input = createTaskInputSchema.parse(request.body);
    return successResponse(services.taskService.createTask(input));
  });

  server.get("/api/sessions/:sessionId/tasks", async (request) => {
    const params = request.params as { sessionId: string };
    return successResponse({
      tasks: services.taskService.listTasks(params.sessionId),
    });
  });

  server.post("/api/tasks/:taskId/complete", async (request) => {
    const params = request.params as { taskId: string };
    const input = completeTaskInputSchema.parse(request.body);
    return successResponse(
      services.taskService.completeTask(params.taskId, input),
    );
  });

  server.put("/api/progress", async (request) => {
    const input = upsertProgressInputSchema.parse(request.body);
    const progress = services.progressService.upsert(input);

    services.websocketService.broadcastProgress({
      type: "progress:update",
      sessionId: progress.sessionId,
      agentId: progress.agentId,
      agentName: progress.agentName,
      status: progress.status,
      percentage: progress.percentage,
      currentStep: progress.currentStep,
      message: progress.message,
      details: progress.details,
      updatedAt: progress.updatedAt,
    });
    broadcastConsoleUpdate(progress.sessionId, "progress_updated");

    return successResponse({ progress });
  });

  server.get("/api/progress/:sessionId/:agentId", async (request) => {
    const params = request.params as { sessionId: string; agentId: string };
    return successResponse({
      progress: services.progressService.get(params.sessionId, params.agentId),
    });
  });

  server.get("/api/progress", async (request) => {
    const query = request.query as {
      sessionId?: string;
      agentId?: string;
      status?: string;
    };
    const filter = listProgressFilterSchema.parse(query);
    return successResponse({
      progressList: services.progressService.list(filter),
    });
  });

  server.delete("/api/progress/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    const cleared = services.progressService.clear(params.sessionId);
    return successResponse({ cleared });
  });
}
