import { DiscussionService } from "./services/discussion-service.js";
import { ToolInstallerService } from "./services/tool-installer-service.js";
import { DiscussionCliService } from "./services/discussion-cli-service.js";
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
import {
  AgentRepository,
  AgentContextRepository,
  DatabaseManager,
  ExternalMcpServerRepository,
  IdentityLeaseRepository,
  MessageRepository,
  MemberRouteRepository,
  DeliveryRepository,
  ModelConfigRepository,
  SessionRepository,
  SessionInsightRepository,
  TaskEventRepository,
  TaskRepository,
  WebAgentRuntimeRepository,
  WorkflowDefinitionRepository,
} from "@loopmarshal/store";

import type { CoreConfig } from "./config.js";
import { dirname, join } from "node:path";
import { NativeCliSessionAdapter } from "./services/native-session-adapters.js";
import { defaultCoreConfig } from "./config.js";
import { createServer } from "./server/create-server.js";
import { MemberRouteService } from "./services/member-route-service.js";
import { ToolConfigService } from "./services/tool-config-service.js";
import { ProxyDeliveryService } from "./services/proxy-delivery-service.js";
import { MemberCredentialService } from "./services/member-credential-service.js";
import {
  ensureCoreManagementToken,
  readCoreManagementToken,
} from "@loopmarshal/shared";
import { managementTokenDigest } from "./server/proxy-auth.js";
import { prepareProxySessionContext } from "./services/proxy-session-context.js";
import { ManagedAgentSetupService } from "./services/managed-agent-setup-service.js";
import {
  AgentService,
  CollaborationWaitService,
  ExternalMcpService,
  ExtractionService,
  GuardService,
  IdentityLeaseService,
  KnowledgeFileStore,
  KnowledgeService,
  McpToolService,
  MessageService,
  ProgressService,
  SessionConsoleService,
  SessionService,
  SessionInsightService,
  TaskService,
  UserPreferencesService,
  WebAgentRuntimeExecutorService,
  WebAgentRuntimeService,
  WebSocketService,
  WindowBindingService,
  WorkflowDefinitionService,
  StdioMcpRegistryService,
  AgentWorkflowRegistry,
  AgentContextService,
} from "./services/index.js";

export const startCoreServer = async (
  config: CoreConfig = defaultCoreConfig,
) => {
  const databaseManager = new DatabaseManager(config.databasePath);
  databaseManager.migrate();

  const sessionRepository = new SessionRepository(databaseManager.connection);
  const agentRepository = new AgentRepository(databaseManager.connection);
  const messageRepository = new MessageRepository(databaseManager.connection);
  const deliveryRepository = new DeliveryRepository(databaseManager.connection);
  const memberRouteRepository = new MemberRouteRepository(
    databaseManager.connection,
  );
  messageRepository.setDeliveryRepository(deliveryRepository);
  const identityLeaseRepository = new IdentityLeaseRepository(
    databaseManager.connection,
  );
  const taskRepository = new TaskRepository(databaseManager.connection);
  const taskEventRepository = new TaskEventRepository(
    databaseManager.connection,
  );
  const sessionInsightRepository = new SessionInsightRepository(
    databaseManager.connection,
  );
  const agentContextRepository = new AgentContextRepository(
    databaseManager.connection,
  );
  const agentContextService = new AgentContextService(agentContextRepository);
  const modelConfigRepository = new ModelConfigRepository(
    databaseManager.connection,
  );
  if (modelConfigRepository.list().length === 0) {
    const timestamp = new Date().toISOString();
    modelConfigRepository.upsert({
      id: "default-model",
      name: "Default Model",
      provider: process.env.LOOPMARSHAL_LLM_PROVIDER ?? "openai",
      modelId: process.env.LOOPMARSHAL_LLM_MODEL ?? "gpt-4o-mini",
      apiKey: null,
      baseUrl: null,
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
      contextReserveTokens: 1000,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  // Resolve credentials per model through getFull(); saved connections must not
  // override other models' environment fallbacks or inherited CLI credentials.
  const webAgentRuntimeRepository = new WebAgentRuntimeRepository(
    databaseManager.connection,
  );
  const workflowDefinitionRepository = new WorkflowDefinitionRepository(
    databaseManager.connection,
  );

  const sessionService = new SessionService(
    databaseManager.connection,
    sessionRepository,
    agentRepository,
    messageRepository,
    taskRepository,
    taskEventRepository,
    sessionInsightRepository,
    identityLeaseRepository,
  );
  const agentService = new AgentService(agentRepository, sessionService);
  const memberRouteService = new MemberRouteService(
    databaseManager.connection,
    memberRouteRepository,
    sessionRepository,
    agentRepository,
    sessionService,
  );
  const sessionInsightService = new SessionInsightService(
    sessionRepository,
    agentRepository,
    sessionInsightRepository,
  );

  const messageService = new MessageService(
    sessionRepository,
    agentRepository,
    messageRepository,
    identityLeaseRepository,
  );
  const identityLeaseService = new IdentityLeaseService(
    identityLeaseRepository,
  );
  const windowBindingService = new WindowBindingService(agentRepository);
  const taskService = new TaskService(
    sessionRepository,
    agentRepository,
    taskRepository,
    taskEventRepository,
  );
  const knowledgeFileStore = new KnowledgeFileStore(process.cwd());
  const websocketService = new WebSocketService();
  const knowledgeService = new KnowledgeService(
    knowledgeFileStore,
    null,
    (sessionId) =>
      websocketService.broadcastConsoleUpdate(sessionId, "knowledge_updated"),
  );
  const userPreferencesService = new UserPreferencesService();
  userPreferencesService.importFromLegacyKnowledgeRoot(
    knowledgeFileStore.getRootPath(),
  );
  const extractionService = new ExtractionService();
  const guardService = new GuardService();

  const proxyDeliveryService = new ProxyDeliveryService(
    databaseManager.connection,
    deliveryRepository,
    memberRouteRepository,
    messageRepository,
    (sessionId) =>
      websocketService.broadcastConsoleUpdate(sessionId, "message_sent"),
    new NativeCliSessionAdapter(
      join(dirname(config.databasePath), "native-session-evidence"),
    ),
    async (delivery) =>
      prepareProxySessionContext(
        services,
        delivery,
        `http://127.0.0.1:${server.server.address() && typeof server.server.address() === "object" ? (server.server.address() as { port: number }).port : config.port}`,
        config.databasePath,
      ),
    (sessionId, agentId, expectedVersion, nativeSessionId, version) =>
      memberRouteService.bindCreatedNativeSession(
        sessionId,
        agentId,
        expectedVersion,
        nativeSessionId,
        version,
      ),
    (sessionId, agentId, expectedVersion, message) =>
      memberRouteService.failNativeSessionCreation(
        sessionId,
        agentId,
        expectedVersion,
        message,
      ),
    (
      sessionId,
      workerAgentId,
      hostAgentId,
      correlationId,
      result,
      idempotencyKey,
    ) =>
      messageService.queueKnowledgeMaintenance(
        sessionId,
        workerAgentId,
        hostAgentId,
        correlationId,
        result,
        idempotencyKey,
      ),
  );
  const progressService = new ProgressService();
  const sessionConsoleService = new SessionConsoleService(
    sessionService,
    messageService,
    progressService,
    knowledgeService,
    memberRouteRepository,
    deliveryRepository,
  );
  const collaborationWaitService = new CollaborationWaitService(
    messageService,
    windowBindingService,
  );
  const externalMcpService = new ExternalMcpService(
    new ExternalMcpServerRepository(databaseManager.connection),
  );
  const mcpToolService = new McpToolService(
    webAgentRuntimeRepository,
    new Map(),
    sessionRepository,
    agentRepository,
  );
  const stdioMcpRegistryService = new StdioMcpRegistryService();
  const webAgentRuntimeService = new WebAgentRuntimeService(
    webAgentRuntimeRepository,
    sessionRepository,
    agentRepository,
    modelConfigRepository,
    memberRouteRepository,
  );
  const workflowDefinitionService = new WorkflowDefinitionService(
    workflowDefinitionRepository,
  );
  workflowDefinitionService.seedBuiltins();

  let services: Parameters<typeof createServer>[1];
  const webAgentRuntimeExecutorService = new WebAgentRuntimeExecutorService(
    () => services,
  );
  const agentWorkflowRegistry = new AgentWorkflowRegistry();

  const toolConfigService = new ToolConfigService(
    databaseManager.connection,
    memberRouteService,
    config.databasePath,
  );
  const toolInstallerService = new ToolInstallerService(
    databaseManager.connection,
    memberRouteService,
    toolConfigService,
  );
  services = {
    toolInstallerService,
    memberCredentialService: new MemberCredentialService(
      databaseManager.connection,
    ),
    proxyManagementTokenHash: managementTokenDigest(
      ensureCoreManagementToken(config.databasePath),
    ),
    readLocalManagementToken: () =>
      readCoreManagementToken(config.databasePath),
    memberRouteService,
    toolConfigService,
    proxyDeliveryService,
    sessionService,
    agentService,
    identityLeaseService,
    messageService,
    taskService,
    sessionInsightService,
    windowBindingService,
    websocketService,
    progressService,
    sessionConsoleService,
    knowledgeService,
    userPreferencesService,
    extractionService,
    guardService,
    modelConfigService: modelConfigRepository,
    discussionService: new DiscussionService(
      databaseManager.connection,
      modelConfigRepository,
      {
        members: memberRouteService,
        configs: toolConfigService,
        cli: new DiscussionCliService(
          join(dirname(config.databasePath), "discussion-runtime"),
        ),
      },
    ),
    externalMcpService,
    mcpToolService,
    stdioMcpRegistryService,
    collaborationWaitService,
    webAgentRuntimeService,
    webAgentRuntimeExecutorService,
    agentWorkflowRegistry,
    agentContextService,
    workflowDefinitionService,
  };
  services.managedAgentSetupService = new ManagedAgentSetupService(
    config.databasePath,
    () => services,
    () =>
      `http://127.0.0.1:${server.server.address() && typeof server.server.address() === "object" ? (server.server.address() as { port: number }).port : config.port}`,
  );

  const server = await createServer(config, services);

  messageService.setWebSocketService(websocketService);
  try {
    proxyDeliveryService.acquireOwnership();
    services.memberCredentialService!.revokeExecutionCredentials();
    await server.listen({ host: config.host, port: config.port });
    services.managedAgentSetupService.reconcile();
    proxyDeliveryService.start();
    for (const runtime of webAgentRuntimeRepository.listRunningEnabled()) {
      webAgentRuntimeExecutorService.start(runtime);
    }
  } catch (error) {
    await proxyDeliveryService.stop();
    webAgentRuntimeExecutorService.stopAll();
    await server.close();
    databaseManager.close();
    throw error;
  }

  return {
    server,
    databaseManager,
    stdioMcpRegistryService,
    close: async () => {
      await toolInstallerService.stop();
      await services.discussionService?.stop();
      await proxyDeliveryService.stop();
      webAgentRuntimeExecutorService.stopAll();
      await server.close();
      databaseManager.close();
    },
  };
};
