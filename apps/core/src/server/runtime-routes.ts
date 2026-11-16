import type { FastifyBaseLogger } from "fastify";
import type { BroadcastConsoleUpdate, RouteServer } from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import type {
  CreateWebAgentRuntimeInput,
  CreateWorkflowDefinitionInput,
  UpdateWebAgentRuntimeInput,
  UpdateWorkflowDefinitionInput,
} from "@loopmarshal/protocol";

import { CoreError } from "../errors.js";
import { saveModelConfigSchema } from "@loopmarshal/protocol";
import { randomUUID } from "node:crypto";
import { createLlmRequest } from "../services/llm-provider-client.js";
import { successResponse } from "./response.js";

export function registerRuntimeRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
): void {
  server.post("/api/sessions/join-with-agent", async (request) => {
    const body = request.body as {
      sessionId: string;
      role: "worker" | "observer" | "knowledge_keeper";
      agentName: string;
      displayName?: string;
      roleDescription?: string | null;
    };
    const result = services.sessionService.joinSession({
      sessionId: body.sessionId,
      agentName: body.agentName,
      displayName: body.displayName ?? body.agentName,
      platform: "generic",
      role: body.role,
      roleDescription: body.roleDescription ?? undefined,
      capabilities: [],
      connectionMode: "skill-bridge",
    });
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse({ agent: result.agent, session: result.session });
  });

  server.post("/api/sessions/create-with-agent", async (request) => {
    const body = request.body as {
      sessionName: string;
      agentName: string;
      displayName?: string;
      roleDescription?: string | null;
    };
    const result = services.sessionService.createSession({
      sessionName: body.sessionName,
      agentName: body.agentName,
      displayName: body.displayName ?? body.agentName,
      platform: "generic",
      roleDescription: body.roleDescription ?? undefined,
      capabilities: [],
      connectionMode: "skill-bridge",
    });
    broadcastConsoleUpdate(result.session.id, "member_changed");
    return successResponse({ agent: result.agent, session: result.session });
  });

  server.get("/api/models", async () => {
    return successResponse(
      services.modelConfigService.list().map(({ apiKey, ...model }) => ({
        ...model,
        apiKey: null,
        hasApiKey: Boolean(apiKey),
      })),
    );
  });

  server.post("/api/models", async (request) => {
    const parsed = saveModelConfigSchema.safeParse(request.body);
    if (!parsed.success)
      throw new CoreError(
        "INVALID_INPUT",
        "模型参数不合法，请检查名称、模型、地址和上下文大小。",
      );
    const body = parsed.data;
    const timestamp = new Date().toISOString();
    const id = body.id ?? `model-${randomUUID()}`;
    const existing = services.modelConfigService.findById(id);
    services.modelConfigService.upsert({
      id,
      name: body.name,
      provider: body.provider,
      modelId: body.modelId,
      apiKey:
        body.apiKey === undefined
          ? (existing?.apiKey ?? null)
          : body.apiKey || null,
      baseUrl:
        body.baseUrl === undefined
          ? (existing?.baseUrl ?? null)
          : body.baseUrl || null,
      contextWindowTokens:
        body.contextWindowTokens ?? existing?.contextWindowTokens ?? 128000,
      maxOutputTokens:
        body.maxOutputTokens ?? existing?.maxOutputTokens ?? 4096,
      contextReserveTokens:
        body.contextReserveTokens ?? existing?.contextReserveTokens ?? 1000,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    const saved = services.modelConfigService.findById(id)!;
    return successResponse({
      ...saved,
      apiKey: null,
      hasApiKey: Boolean(saved.apiKey),
    });
  });

  server.delete("/api/models/:modelId", async (request) => {
    const params = request.params as { modelId: string };
    services.modelConfigService.delete(params.modelId);
    return successResponse({ deleted: true });
  });

  server.post("/api/llm/chat", async (request) => {
    const body = request.body as {
      modelConfigId?: string;
      messages?: Array<{ role: string; content: string }>;
      tools?: unknown[];
      tool_choice?: unknown;
      temperature?: number;
      stream?: boolean;
    };
    const modelId = body.modelConfigId ?? "default-model";
    const model = services.modelConfigService.getFull(modelId);
    const { response, parse } = await createLlmRequest(model, {
      messages: body.messages ?? [],
      ...(body.tools ? { tools: body.tools } : {}),
      ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(body.stream !== undefined ? { stream: body.stream } : {}),
    });
    if (!response.ok) {
      throw new CoreError(
        "INVALID_INPUT",
        `LLM HTTP ${response.status}: ${await response.text()}`,
        response.status,
      );
    }
    return successResponse(await parse());
  });

  server.get("/api/workflows", async () => {
    return successResponse(services.workflowDefinitionService.list());
  });

  server.get("/api/workflows/:workflowId", async (request) => {
    const params = request.params as { workflowId: string };
    return successResponse(
      services.workflowDefinitionService.get(params.workflowId),
    );
  });

  server.post("/api/workflows", async (request) => {
    return successResponse(
      services.workflowDefinitionService.create(
        request.body as CreateWorkflowDefinitionInput,
      ),
    );
  });

  server.put("/api/workflows/:workflowId", async (request) => {
    const params = request.params as { workflowId: string };
    return successResponse(
      services.workflowDefinitionService.update(
        params.workflowId,
        request.body as UpdateWorkflowDefinitionInput,
      ),
    );
  });

  server.delete("/api/workflows/:workflowId", async (request) => {
    const params = request.params as { workflowId: string };
    return successResponse(
      services.workflowDefinitionService.delete(params.workflowId),
    );
  });

  server.get("/api/web-agent-runtimes", async (request) => {
    const query = request.query as { sessionId?: string };
    if (!query.sessionId) {
      return successResponse([]);
    }
    return successResponse(
      services.webAgentRuntimeService.list(query.sessionId),
    );
  });

  server.post("/api/web-agent-runtimes", async (request) => {
    const body = request.body as Partial<CreateWebAgentRuntimeInput>;
    if (!["host", "worker", "knowledge_keeper"].includes(body.role ?? ""))
      throw new CoreError("INVALID_INPUT", "请选择有效角色。");
    const runtime = services.webAgentRuntimeService.createOrUpdate({
      sessionId: String(body.sessionId),
      agentId: String(body.agentId),
      role: body.role!,
      modelConfigId: body.modelConfigId ?? "default-model",
      agentProfileId: body.agentProfileId ?? null,
      toolsetId:
        body.toolsetId ?? (body.role === "worker" ? "developer" : body.role!),
      customDuty: body.customDuty ?? null,
      customSkillIds: body.customSkillIds ?? [],
      externalMcpServerIds: body.externalMcpServerIds ?? [],
    });
    broadcastConsoleUpdate(runtime.sessionId, "member_changed");
    return successResponse(runtime);
  });

  server.get("/api/web-agent-runtimes/:runtimeId", async (request) => {
    const params = request.params as { runtimeId: string };
    return successResponse(
      services.webAgentRuntimeService.get(params.runtimeId),
    );
  });

  server.patch("/api/web-agent-runtimes/:runtimeId", async (request) => {
    const params = request.params as { runtimeId: string };
    return successResponse(
      services.webAgentRuntimeService.update(
        params.runtimeId,
        request.body as UpdateWebAgentRuntimeInput,
      ),
    );
  });

  server.delete(
    "/api/web-agent-runtimes/:runtimeId",
    async (request, reply) => {
      const params = request.params as { runtimeId: string };
      const runtime = services.webAgentRuntimeService.get(params.runtimeId);
      // Guard: only knowledge_keeper runtimes can be deleted from the web.
      // Host runtime is the session core and must not be deleted.
      // Other roles (worker) are managed by their respective IDEs.
      if (!runtime) {
        return successResponse({ deleted: false, error: "Runtime not found" });
      }
      if (runtime.role === "host") {
        reply.code(403);
        return successResponse({
          deleted: false,
          error: `Cannot delete the Host runtime from the member list.`,
        });
      }
      services.webAgentRuntimeExecutorService.stop(params.runtimeId);
      services.webAgentRuntimeService.delete(params.runtimeId);
      // Also remove the agent from the session so it disappears from the member list
      try {
        services.sessionService.removeAgent(runtime.agentId);
      } catch {
        // Agent removal failure is non-fatal — runtime is already deleted
      }
      broadcastConsoleUpdate(runtime.sessionId, "member_changed");
      return successResponse({ deleted: true });
    },
  );

  server.post("/api/web-agent-runtimes/:runtimeId/start", async (request) => {
    const params = request.params as { runtimeId: string };
    const runtime = services.webAgentRuntimeService.setStatus(
      params.runtimeId,
      "running",
    );
    services.webAgentRuntimeExecutorService.start(runtime);
    return successResponse(runtime);
  });

  server.post("/api/web-agent-runtimes/:runtimeId/pause", async (request) => {
    const params = request.params as { runtimeId: string };
    services.webAgentRuntimeExecutorService.stop(params.runtimeId);
    return successResponse(
      services.webAgentRuntimeService.setStatus(params.runtimeId, "paused"),
    );
  });

  server.post("/api/web-agent-runtimes/:runtimeId/stop", async (request) => {
    const params = request.params as { runtimeId: string };
    services.webAgentRuntimeExecutorService.stop(params.runtimeId);
    return successResponse(
      services.webAgentRuntimeService.setStatus(params.runtimeId, "stopped"),
    );
  });
}
