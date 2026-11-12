import type { ModelConfigRepository } from "@loopmarshal/store";
import type { AgentContextService } from "../services/agent-context-service.js";
import type { AgentWorkflowRegistry } from "../services/agent-workflow-registry.js";
import type {
  AgentService,
  CollaborationWaitService,
  ExternalMcpService,
  ExtractionService,
  GuardService,
  IdentityLeaseService,
  KnowledgeService,
  McpToolService,
  MessageService,
  ProgressService,
  SessionConsoleService,
  SessionInsightService,
  SessionService,
  StdioMcpRegistryService,
  TaskService,
  UserPreferencesService,
  WebAgentRuntimeExecutorService,
  WebAgentRuntimeService,
  WebSocketService,
  WindowBindingService,
  WorkflowDefinitionService,
} from "../services/index.js";
import type { ManagedAgentSetupService } from "../services/managed-agent-setup-service.js";
import type { MemberCredentialService } from "../services/member-credential-service.js";
import type { MemberRouteService } from "../services/member-route-service.js";
import type { ProxyDeliveryService } from "../services/proxy-delivery-service.js";
import type { ToolConfigService } from "../services/tool-config-service.js";

export type ServerServices = {
  managedAgentSetupService?: ManagedAgentSetupService;
  toolConfigService?: ToolConfigService;
  memberCredentialService?: MemberCredentialService;
  proxyManagementTokenHash?: string;
  readLocalManagementToken?: () => string | null;
  memberRouteService?: MemberRouteService;
  proxyDeliveryService?: ProxyDeliveryService;
  sessionService: SessionService;
  agentService: AgentService;
  identityLeaseService: IdentityLeaseService;
  messageService: MessageService;
  taskService: TaskService;
  sessionInsightService: SessionInsightService;
  windowBindingService: WindowBindingService;
  websocketService: WebSocketService;
  progressService: ProgressService;
  sessionConsoleService: SessionConsoleService;
  knowledgeService: KnowledgeService;
  userPreferencesService: UserPreferencesService;
  extractionService: ExtractionService;
  guardService: GuardService;
  modelConfigService: ModelConfigRepository;
  externalMcpService: ExternalMcpService;
  mcpToolService: McpToolService;
  stdioMcpRegistryService: StdioMcpRegistryService;
  collaborationWaitService: CollaborationWaitService;
  webAgentRuntimeService: WebAgentRuntimeService;
  webAgentRuntimeExecutorService: WebAgentRuntimeExecutorService;
  agentWorkflowRegistry: AgentWorkflowRegistry;
  agentContextService: AgentContextService;
  workflowDefinitionService: WorkflowDefinitionService;
  /** 可选的 LLM 覆盖，用于测试时注入 Fake LLM，替代 createLlmRequest 的 HTTP 调用 */
  llmOverride?: (
    systemPrompt: string,
    userContent: string,
    tools?: unknown[],
  ) => Promise<{
    content: string;
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
  }>;
};
