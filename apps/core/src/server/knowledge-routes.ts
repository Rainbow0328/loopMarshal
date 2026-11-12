import type { FastifyBaseLogger } from "fastify";
import type { BroadcastConsoleUpdate, RouteServer } from "./route-types.js";
import type { ServerServices } from "./server-services.js";

import {
  knowledgeLevels,
  knowledgePatchStatuses,
  knowledgeSourceKinds,
  type DeleteKnowledgeInput,
  type KnowledgeLevel,
  type KnowledgePatchStatus,
  type KnowledgeSourceKind,
  type UpsertKnowledgeInput,
} from "@loopmarshal/protocol";

import { CoreError, coreErrors } from "../errors.js";
import { successResponse } from "./response.js";

import type { FastifyRequest } from "fastify";

export function registerKnowledgeRoutes<Logger extends FastifyBaseLogger>(
  server: RouteServer<Logger>,
  services: ServerServices,
  broadcastConsoleUpdate: BroadcastConsoleUpdate,
): void {
  const knowledgeForRequest = (request: FastifyRequest) => {
    const sessionId =
      (request.query as { sessionId?: string })?.sessionId ??
      (request.body as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) return services.knowledgeService;
    if (
      typeof sessionId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
    )
      throw coreErrors.invalidInput("Invalid knowledge session ID.");
    services.sessionService.getSession(sessionId);
    return services.knowledgeService.forSession(sessionId);
  };

  server.get("/api/knowledge", async (request) => {
    const query = request.query as {
      level?: string;
      tag?: string;
      query?: string;
    };
    const level = isKnowledgeLevel(query.level) ? query.level : undefined;
    return successResponse({
      manifest: knowledgeForRequest(request).getManifest(),
      items: knowledgeForRequest(request).list({
        ...(level ? { level } : {}),
        ...(query.tag ? { tag: query.tag } : {}),
        ...(query.query ? { query: query.query } : {}),
      }),
    });
  });

  server.get("/api/knowledge/changes", async (request) => {
    const query = request.query as {
      level?: string;
      slug?: string;
      limit?: string;
    };
    const level = isKnowledgeLevel(query.level) ? query.level : undefined;
    return successResponse({
      changes: knowledgeForRequest(request).listChanges({
        ...(level ? { level } : {}),
        ...(query.slug ? { slug: query.slug } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      }),
    });
  });

  server.get("/api/knowledge/:level/:slug", async (request) => {
    const params = request.params as { level: string; slug: string };
    if (!isKnowledgeLevel(params.level)) {
      throw new CoreError(
        "INVALID_INPUT",
        `Unknown knowledge level "${params.level}".`,
      );
    }
    return successResponse({
      document: knowledgeForRequest(request).get(params.level, params.slug),
    });
  });

  server.put("/api/knowledge/:level/:slug", async (request) => {
    const params = request.params as { level: string; slug: string };
    if (!isKnowledgeLevel(params.level)) {
      throw new CoreError(
        "INVALID_INPUT",
        `Unknown knowledge level "${params.level}".`,
      );
    }
    const body: Partial<Omit<UpsertKnowledgeInput, "level" | "slug">> =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Partial<
            Omit<UpsertKnowledgeInput, "level" | "slug">
          >)
        : {};
    if (body.sourceKind && !isKnowledgeSourceKind(body.sourceKind)) {
      throw new CoreError(
        "INVALID_INPUT",
        `Unknown knowledge source kind "${body.sourceKind}".`,
      );
    }
    const guard = services.guardService.check({
      level: params.level,
      slug: params.slug,
      content: body.content ?? "",
    });
    if (!guard.ok) {
      throw new CoreError(
        "INVALID_INPUT",
        guard.violations.map((entry) => entry.message).join("; "),
      );
    }
    const document = knowledgeForRequest(request).upsert({
      level: params.level,
      slug: params.slug,
      title: body.title ?? params.slug,
      content: body.content ?? "",
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.ownerAgentId !== undefined
        ? { ownerAgentId: body.ownerAgentId }
        : {}),
      ...(body.sourceKind ? { sourceKind: body.sourceKind } : {}),
      ...(body.sourceAgentId !== undefined
        ? { sourceAgentId: body.sourceAgentId }
        : {}),
      ...(body.changeSummary !== undefined
        ? { changeSummary: body.changeSummary }
        : {}),
    });
    services.websocketService.broadcastConsoleUpdateToAll("knowledge_updated");
    return successResponse({
      document,
    });
  });

  server.delete("/api/knowledge/:level/:slug", async (request) => {
    const params = request.params as { level: string; slug: string };
    if (!isKnowledgeLevel(params.level)) {
      throw new CoreError(
        "INVALID_INPUT",
        `Unknown knowledge level "${params.level}".`,
      );
    }
    const body: Partial<Omit<DeleteKnowledgeInput, "level" | "slug">> =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Partial<
            Omit<DeleteKnowledgeInput, "level" | "slug">
          >)
        : {};
    if (body.sourceKind && !isKnowledgeSourceKind(body.sourceKind)) {
      throw new CoreError(
        "INVALID_INPUT",
        `Unknown knowledge source kind "${body.sourceKind}".`,
      );
    }
    const result = knowledgeForRequest(request).delete({
      level: params.level,
      slug: params.slug,
      ...(body.sourceKind ? { sourceKind: body.sourceKind } : {}),
      ...(body.sourceAgentId !== undefined
        ? { sourceAgentId: body.sourceAgentId }
        : {}),
      ...(body.changeSummary !== undefined
        ? { changeSummary: body.changeSummary }
        : {}),
    });
    services.websocketService.broadcastConsoleUpdateToAll("knowledge_updated");
    return successResponse(result);
  });

  server.get("/api/knowledge/patches/pending", async (request) => {
    return successResponse({
      patches: knowledgeForRequest(request).listPendingPatchRecords(),
    });
  });

  server.get("/api/user-preferences", async (request) => {
    const query = request.query as {
      category?: string;
      query?: string;
    };
    return successResponse({
      manifest: services.userPreferencesService.getManifest(),
      preferences: services.userPreferencesService.list({
        ...(query.category ? { category: query.category } : {}),
        ...(query.query ? { query: query.query } : {}),
      }),
    });
  });

  server.put("/api/user-preferences/:key", async (request) => {
    const params = request.params as { key: string };
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as {
            value?: string;
            category?: string | null;
            source?: "manual" | "agent" | "system";
          })
        : {};
    const preference = services.userPreferencesService.upsert({
      key: params.key,
      value: body.value ?? "",
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.source ? { source: body.source } : {}),
    });
    return successResponse({ preference });
  });

  server.delete("/api/user-preferences/:key", async (request) => {
    const params = request.params as { key: string };
    return successResponse(services.userPreferencesService.delete(params.key));
  });

  server.get("/api/knowledge/patches/:patchId", async (request) => {
    const params = request.params as { patchId: string };
    const patchRecord = knowledgeForRequest(request).getPatchRecord(
      params.patchId,
    );
    if (!patchRecord) {
      throw new CoreError(
        "KNOWLEDGE_DOCUMENT_NOT_FOUND",
        `Knowledge patch "${params.patchId}" not found.`,
      );
    }
    const reviewRecord = knowledgeForRequest(request).getPatchReviewRecord(
      params.patchId,
    );
    const persistenceRecord = knowledgeForRequest(request).getPersistenceRecord(
      params.patchId,
    );
    return successResponse({
      patch: patchRecord,
      review: reviewRecord,
      persistence: persistenceRecord,
    });
  });

  server.get("/api/knowledge/patches", async (request) => {
    const query = request.query as {
      status?: string;
    };
    const status =
      query.status &&
      knowledgePatchStatuses.includes(query.status as KnowledgePatchStatus)
        ? (query.status as KnowledgePatchStatus)
        : undefined;
    return successResponse({
      patches: knowledgeForRequest(request).listPatchRecords({
        ...(status ? { status } : {}),
      }),
    });
  });

  server.post("/api/knowledge/patches/:patchId/adjudicate", async (request) => {
    const params = request.params as { patchId: string };
    const body: Partial<
      Omit<
        import("@loopmarshal/protocol").AdjudicateKnowledgePatchInput,
        "patchId"
      >
    > =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Partial<
            Omit<
              import("@loopmarshal/protocol").AdjudicateKnowledgePatchInput,
              "patchId"
            >
          >)
        : {};
    if (!body.decision) {
      throw new CoreError(
        "INVALID_INPUT",
        "Adjudication decision is required.",
      );
    }
    const result = knowledgeForRequest(request).adjudicatePatch({
      patchId: params.patchId,
      decision: body.decision,
      reviewedBy: body.reviewedBy ?? "system",
      ...(body.reviewComment !== undefined
        ? { reviewComment: body.reviewComment }
        : {}),
      ...(body.reviewedAt ? { reviewedAt: body.reviewedAt } : {}),
    });
    services.websocketService.broadcastConsoleUpdateToAll("knowledge_updated");
    return successResponse(result);
  });

  server.post("/api/knowledge/patches/:patchId/execute", async (request) => {
    const params = request.params as { patchId: string };
    const result = knowledgeForRequest(request).executeApprovedPatchPersistence(
      params.patchId,
    );
    services.websocketService.broadcastConsoleUpdateToAll("knowledge_updated");
    return successResponse(result);
  });
}

const isKnowledgeLevel = (
  value: string | undefined,
): value is KnowledgeLevel => {
  return (
    typeof value === "string" &&
    (knowledgeLevels as readonly string[]).includes(value)
  );
};

const isKnowledgeSourceKind = (
  value: string | undefined,
): value is KnowledgeSourceKind => {
  return (
    typeof value === "string" &&
    (knowledgeSourceKinds as readonly string[]).includes(value)
  );
};
