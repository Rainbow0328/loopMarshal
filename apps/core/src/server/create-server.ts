import { registerDiscussionRoutes } from "./discussion-routes.js";
import { registerToolInstallerRoutes } from "./tool-installer-routes.js";
/*
 * Copyright 2024 Cloud Skill Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import websocket from "@fastify/websocket";
import { type WsConsoleUpdateReason } from "@loopmarshal/protocol";
import { getLogger } from "@loopmarshal/shared";
import type { FastifyRequest } from "fastify";
import Fastify from "fastify";

import type { CoreConfig } from "../config.js";
import { CoreError } from "../errors.js";
import { registerMemberRouteRoutes } from "./member-route-routes.js";
import {
  assertSameOrigin,
  authorizeProxyRequest,
  isLoopbackRequest,
  memberBearer,
} from "./proxy-auth.js";
import { registerProxyDeliveryRoutes } from "./proxy-delivery-routes.js";
import { logApiAudit } from "./request-audit.js";
import { errorResponse, successResponse } from "./response.js";
import { registerToolConfigRoutes } from "./tool-config-routes.js";

import { registerKnowledgeRoutes } from "./knowledge-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerMessageRoutes } from "./message-routes.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import type { ServerServices } from "./server-services.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerTaskRoutes } from "./task-routes.js";
import { registerWebFrontend } from "./web-frontend.js";

export type { ServerServices } from "./server-services.js";

export const createServer = async (
  config: CoreConfig,
  services: ServerServices,
) => {
  const logger = getLogger();
  const server = Fastify({
    disableRequestLogging: false,
    loggerInstance: logger,
  });

  await server.register(websocket);
  if (services.proxyManagementTokenHash) {
    server.get("/api/local-auth", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      assertSameOrigin(request);
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
        throw new CoreError(
          "PERMISSION_DENIED",
          "Management credentials are only available locally.",
          403,
        );
      let localHost = false;
      try {
        localHost = ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(`http://${request.headers.host}`).hostname,
        );
      } catch {
        /* Reject invalid authorities. */
      }
      if (!localHost)
        throw new CoreError(
          "PERMISSION_DENIED",
          "Open the local application using localhost or a loopback address.",
          403,
        );
      const token = services.readLocalManagementToken?.();
      if (!token)
        throw new CoreError(
          "PERMISSION_DENIED",
          "Local management credential is unavailable.",
          403,
        );
      return { token };
    });
    server.addHook("onRequest", async (request) => {
      const url = request.url.split("?")[0] ?? "";
      if (url.startsWith("/api/") || url.startsWith("/ws")) {
        assertSameOrigin(request);
        const bearer = memberBearer(request);
        if (bearer !== null) {
          if (
            request.method !== "POST" ||
            ![
              "/api/messages/send",
              "/api/messages/send-by-name",
              "/api/mcp/call",
            ].includes(url)
          ) {
            throw new CoreError(
              "PERMISSION_DENIED",
              "Member credentials only authorize sending as that member.",
              403,
            );
          }
          if (!services.memberCredentialService)
            throw new CoreError(
              "PERMISSION_DENIED",
              "Member credential service is unavailable.",
              403,
            );
          services.memberCredentialService.authenticate(bearer);
        } else if (url !== "/api/local-auth" && !isLoopbackRequest(request)) {
          authorizeProxyRequest(request, services.proxyManagementTokenHash!);
        }
      }
      if (
        url.startsWith("/api/") &&
        (url.startsWith("/api/discussions") ||
          url.startsWith("/api/tool-installer") ||
          url.startsWith("/api/tool-config") ||
          url.startsWith("/api/tool-installations") ||
          url.includes("/member-routes") ||
          url.endsWith("/proxy-members") ||
          url.includes("/deliveries") ||
          url.endsWith("/activity"))
      ) {
        authorizeProxyRequest(request, services.proxyManagementTokenHash!);
      }
    });
  }
  if (services.memberRouteService)
    registerMemberRouteRoutes(
      server,
      services.memberRouteService,
      (sessionId) => {
        services.managedAgentSetupService?.syncSession(sessionId);
        services.websocketService.broadcastConsoleUpdate(
          sessionId,
          "member_changed",
        );
      },
    );
  if (services.discussionService)
    registerDiscussionRoutes(server, services.discussionService);
  if (services.toolInstallerService)
    registerToolInstallerRoutes(server, services.toolInstallerService);
  if (services.toolConfigService)
    registerToolConfigRoutes(
      server,
      services.toolConfigService,
      services.modelConfigService,
    );
  if (services.proxyDeliveryService)
    registerProxyDeliveryRoutes(server, services.proxyDeliveryService);

  if (services.memberCredentialService) {
    server.get(
      "/api/sessions/:sessionId/member-routes/:agentId/credentials",
      async (request) => {
        const { sessionId, agentId } = request.params as {
          sessionId: string;
          agentId: string;
        };
        return successResponse({
          credentials: services.memberCredentialService!.list(
            sessionId,
            agentId,
          ),
        });
      },
    );
    server.post(
      "/api/sessions/:sessionId/member-routes/:agentId/credentials",
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const { sessionId, agentId } = request.params as {
          sessionId: string;
          agentId: string;
        };
        const label = (request.body as { label?: unknown } | null)?.label;
        if (typeof label !== "string" || !label.trim() || label.length > 120)
          throw new CoreError(
            "INVALID_INPUT",
            "A credential label of 1–120 characters is required.",
          );
        return successResponse(
          services.memberCredentialService!.issue(
            sessionId,
            agentId,
            label.trim(),
          ),
        );
      },
    );
    server.delete(
      "/api/sessions/:sessionId/member-routes/:agentId/credentials/:credentialId",
      async (request) => {
        const { sessionId, agentId, credentialId } = request.params as {
          sessionId: string;
          agentId: string;
          credentialId: string;
        };
        services.memberCredentialService!.revoke(
          sessionId,
          agentId,
          credentialId,
        );
        return successResponse({ revoked: true });
      },
    );
  }

  const authorizeSender = (
    request: FastifyRequest,
    sessionId: string,
    agentId: string,
    required: boolean,
  ) => {
    const bearer = memberBearer(request);
    if (bearer !== null) {
      if (!services.memberCredentialService)
        throw new CoreError(
          "PERMISSION_DENIED",
          "Member credentials are unavailable.",
          403,
        );
      services.memberCredentialService.assertSender(bearer, sessionId, agentId);
    } else if (required && services.proxyManagementTokenHash)
      authorizeProxyRequest(request, services.proxyManagementTokenHash);
  };

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof CoreError) {
      void reply
        .status(error.statusCode)
        .send(errorResponse(error.code, error.message));
      return;
    }

    server.log.error(error);

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode ?? 500)
        : 500;

    void reply
      .status(statusCode)
      .send(
        errorResponse(
          "INTERNAL_SERVER_ERROR",
          error instanceof Error ? error.message : "Unexpected core error.",
        ),
      );
  });

  server.addHook("onSend", async (request, reply, payload) => {
    logApiAudit(request, reply, payload);
    return payload;
  });

  const broadcastConsoleUpdate = (
    sessionId: string,
    reason: WsConsoleUpdateReason,
  ) => {
    if (reason === "member_changed") {
      if (
        services.sessionService
          .listSessions()
          .some((session) => session.id === sessionId)
      )
        services.managedAgentSetupService?.syncSession(sessionId);
      else services.managedAgentSetupService?.removeSession(sessionId);
    }
    services.websocketService.broadcastConsoleUpdate(sessionId, reason);
  };

  server.get("/health", async () => {
    return successResponse({
      status: "ok",
      service: "loopmarshal-core",
      host: config.host,
      port: config.port,
    });
  });

  server.get("/api/status", async () => {
    return successResponse({
      status: "running",
      message: "Core scaffold is initialized.",
    });
  });

  registerKnowledgeRoutes(server, services, broadcastConsoleUpdate);

  registerSessionRoutes(server, services, broadcastConsoleUpdate);

  registerMessageRoutes(
    server,
    services,
    broadcastConsoleUpdate,
    authorizeSender,
  );

  registerTaskRoutes(server, services, broadcastConsoleUpdate);

  registerRuntimeRoutes(server, services, broadcastConsoleUpdate);

  registerMcpRoutes(server, services, broadcastConsoleUpdate, authorizeSender);

  services.websocketService.register(server);
  registerWebFrontend(server);

  return server;
};
