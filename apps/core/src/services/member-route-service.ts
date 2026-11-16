import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createProxyMemberInputSchema,
  createToolInstallationInputSchema,
  updateMemberRouteInputSchema,
  updateToolInstallationInputSchema,
  nativeSessionBindingSchema,
  type CreateProxyMemberInput,
  type CreateToolInstallationInput,
  type NativeSessionBinding,
  type SessionMemberRoute,
  type SessionMemberRouteView,
  type ToolInstallation,
  type UpdateMemberRouteInput,
  type NativeSessionDiscoveryResult,
} from "@loopmarshal/protocol";
import {
  AgentRepository,
  DeliveryRepository,
  MemberRouteRepository,
  SessionRepository,
  inStoreTransaction,
} from "@loopmarshal/store";
import { CoreError, coreErrors } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { discoverNativeSessions } from "./native-session-adapters.js";
import { installationCompatibility } from "./tool-compatibility-service.js";

export class MemberRouteService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly routes: MemberRouteRepository,
    private readonly sessions: SessionRepository,
    private readonly agents: AgentRepository,
    private readonly sessionService: SessionService,
  ) {}

  public listInstallations(): ToolInstallation[] {
    return this.routes.listInstallations().map((item) => ({
      ...item,
      compatibility: installationCompatibility(item),
    }));
  }

  public discoverNativeSessions(
    installationId: string,
    workspacePath: string,
    runtimeNamespace: string,
  ): NativeSessionDiscoveryResult {
    const installation = this.requireInstallation(installationId);
    const workspace = this.canonicalPath(workspacePath, true);
    const namespace = runtimeNamespace.trim()
      ? this.canonicalPath(runtimeNamespace, true)
      : "";
    return discoverNativeSessions(installation.toolId, namespace, workspace);
  }

  public createInstallation(
    raw: CreateToolInstallationInput,
  ): ToolInstallation {
    const input = createToolInstallationInputSchema.parse(raw);
    const executablePath = this.canonicalPath(input.executablePath, false);
    const timestamp = new Date().toISOString();
    const installation: ToolInstallation = {
      ...input,
      executablePath,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.routes.insertInstallation(installation);
    return {
      ...installation,
      compatibility: installationCompatibility(installation),
    };
  }

  public updateInstallation(id: string, raw: unknown): ToolInstallation {
    const current = this.requireInstallation(id);
    const input = updateToolInstallationInputSchema.parse(raw);
    const merged = createToolInstallationInputSchema.parse({
      toolId: current.toolId,
      displayName: input.displayName ?? current.displayName,
      executablePath: input.executablePath ?? current.executablePath,
      executableArgs: input.executableArgs ?? current.executableArgs,
      environmentKeys: input.environmentKeys ?? current.environmentKeys,
      version: input.version === undefined ? current.version : input.version,
    });
    const executablePath = this.canonicalPath(merged.executablePath, false);
    const updated: ToolInstallation = {
      ...merged,
      ...(current.managedPaths ? { managedPaths: current.managedPaths } : {}),
      id: current.id,
      executablePath,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (!this.routes.updateInstallation(updated))
      throw new CoreError(
        "TOOL_INSTALLATION_NOT_FOUND",
        "Tool installation was not found.",
        404,
      );
    return { ...updated, compatibility: installationCompatibility(updated) };
  }

  public list(sessionId: string): SessionMemberRouteView[] {
    if (!this.sessions.findById(sessionId))
      throw coreErrors.sessionNotFound(sessionId);
    return this.routes.list(sessionId).map((route) => this.view(route));
  }

  public get(sessionId: string, agentId: string): SessionMemberRouteView {
    const route = this.routes.get(agentId);
    if (!route) throw coreErrors.agentNotFound(agentId);
    if (route.sessionId !== sessionId)
      throw coreErrors.crossSessionAgent(agentId, sessionId);
    return this.view(route);
  }

  public createProxyMember(
    sessionId: string,
    raw: CreateProxyMemberInput,
  ): SessionMemberRouteView {
    const input = createProxyMemberInputSchema.parse(raw);
    return inStoreTransaction(this.database, () => {
      if (this.agents.findBySessionIdAndAgentName(sessionId, input.agentName)) {
        throw coreErrors.duplicateAgentName(sessionId, input.agentName);
      }
      const installation = this.requireInstallation(
        input.binding.installationId,
      );
      const creating = !input.binding.nativeSessionId?.trim();
      const binding = {
        ...input.binding,
        nativeSessionId:
          input.binding.nativeSessionId?.trim() ||
          `loopmarshal-pending:${randomUUID()}`,
      };
      const { agent } = this.sessionService.joinSession({
        sessionId,
        agentName: input.agentName,
        displayName: input.displayName ?? input.agentName,
        platform: installation.toolId,
        role: input.role ?? "worker",
        roleDescription: input.roleDescription,
        capabilities: [],
        connectionMode: "skill-bridge",
      });
      const registered = this.update(sessionId, agent.id, {
        accessMode: "managed_proxy",
        expectedBindingVersion: 1,
        binding,
        reason: creating
          ? "Create native session on first task"
          : "Register existing native session",
      });
      return creating
        ? this.markInitializing(
            sessionId,
            agent.id,
            registered.route.bindingVersion,
          )
        : registered;
    });
  }

  public createAwaitMember(
    sessionId: string,
    input: {
      agentName: string;
      roleDescription: string;
      role?: "worker" | "knowledge_keeper";
      accessMode: "mcp_await" | "cli_await";
    },
  ): SessionMemberRouteView {
    return inStoreTransaction(this.database, () => {
      if (this.agents.findBySessionIdAndAgentName(sessionId, input.agentName))
        throw coreErrors.duplicateAgentName(sessionId, input.agentName);
      const { agent } = this.sessionService.joinSession({
        sessionId,
        agentName: input.agentName,
        displayName: input.agentName,
        role: input.role ?? "worker",
        platform: "generic",
        roleDescription: input.roleDescription,
        capabilities: [],
        connectionMode: "skill-bridge",
      });
      return this.update(sessionId, agent.id, {
        accessMode: input.accessMode,
        expectedBindingVersion: 1,
        reason: "Register waiting member",
      });
    });
  }

  public markInitializing(
    sessionId: string,
    agentId: string,
    expectedVersion: number,
  ): SessionMemberRouteView {
    return inStoreTransaction(this.database, () => {
      const current = this.get(sessionId, agentId);
      if (
        current.route.bindingVersion !== expectedVersion ||
        current.route.accessMode !== "managed_proxy" ||
        !current.route.binding
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member setup changed before native session creation was scheduled.",
          409,
        );
      }
      const timestamp = new Date().toISOString();
      const route: SessionMemberRoute = {
        ...current.route,
        bindingStatus: "initializing",
        lastError: null,
        updatedAt: timestamp,
      };
      if (
        !this.routes.update(route, expectedVersion, {
          id: randomUUID(),
          sessionId,
          agentId,
          bindingVersion: expectedVersion,
          reason: "Native session will be created by the first task",
          before: current.route,
          after: route,
          createdAt: timestamp,
        })
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member setup changed before native session creation was scheduled.",
          409,
        );
      }
      return this.view(route);
    });
  }

  public bindCreatedNativeSession(
    sessionId: string,
    agentId: string,
    expectedVersion: number,
    nativeSessionId: string,
    verifiedToolVersion: string,
  ): SessionMemberRouteView {
    return inStoreTransaction(this.database, () => {
      const current = this.get(sessionId, agentId);
      if (
        current.route.bindingStatus !== "initializing" ||
        current.route.bindingVersion !== expectedVersion ||
        !current.route.binding
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Native session setup changed before the tool returned its session ID.",
          409,
        );
      }
      const binding = nativeSessionBindingSchema.parse({
        ...current.route.binding,
        nativeSessionId,
      });
      const installation = this.requireInstallation(binding.installationId);
      const endpointIdentity = binding.endpoint
        ? new URL(binding.endpoint).href.replace(/\/$/, "")
        : null;
      const namespace =
        process.platform === "win32"
          ? binding.runtimeNamespace.toLowerCase()
          : binding.runtimeNamespace;
      const nativeSessionKey = createHash("sha256")
        .update(
          JSON.stringify([
            installation.toolId,
            endpointIdentity ?? namespace,
            binding.nativeSessionId,
          ]),
        )
        .digest("hex");
      const occupied = this.routes.findByNativeSessionKey(nativeSessionKey);
      if (occupied && occupied.agentId !== agentId)
        throw new CoreError(
          "NATIVE_SESSION_IN_USE",
          "The newly created native session is already bound to another member.",
          409,
        );
      const timestamp = new Date().toISOString();
      const route: SessionMemberRoute = {
        ...current.route,
        binding,
        nativeSessionKey,
        bindingStatus: "ready",
        bindingVersion: expectedVersion + 1,
        verifiedAt: timestamp,
        verifiedToolVersion,
        lastError: null,
        updatedAt: timestamp,
      };
      if (
        !this.routes.update(route, expectedVersion, {
          id: randomUUID(),
          sessionId,
          agentId,
          bindingVersion: route.bindingVersion,
          reason: `Created native session ${nativeSessionId}`,
          before: current.route,
          after: route,
          createdAt: timestamp,
        })
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member binding changed while creating the native session.",
          409,
        );
      }
      new DeliveryRepository(this.database).bindQueuedNativeCreation(
        agentId,
        expectedVersion,
        { binding, installation, nativeSessionKey },
        route.bindingVersion,
      );
      return this.view(route);
    });
  }

  public failNativeSessionCreation(
    sessionId: string,
    agentId: string,
    expectedVersion: number,
    message: string,
  ): SessionMemberRouteView {
    const current = this.get(sessionId, agentId);
    if (
      current.route.bindingStatus === "initializing" &&
      current.route.bindingVersion === expectedVersion
    ) {
      this.routes.failInitialization(current.route, expectedVersion, message);
    }
    return this.get(sessionId, agentId);
  }

  public retryNativeSessionCreation(
    sessionId: string,
    agentId: string,
    expectedVersion: number,
  ): SessionMemberRouteView {
    return inStoreTransaction(this.database, () => {
      const current = this.get(sessionId, agentId);
      if (
        current.route.bindingVersion !== expectedVersion ||
        current.route.accessMode !== "managed_proxy" ||
        current.route.bindingStatus !== "blocked" ||
        !current.route.binding?.nativeSessionId.startsWith(
          "loopmarshal-pending:",
        )
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "This member is not waiting to create a new native session.",
          409,
        );
      }
      if (
        this.database
          .prepare(
            "SELECT 1 FROM message_deliveries WHERE target_agent_id = ? AND state IN ('delivering','awaiting_result','unknown') LIMIT 1",
          )
          .get(agentId)
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_BUSY",
          "A previous native session creation has an uncertain result. Review it before retrying.",
          409,
        );
      }
      const route = this.routes.retryInitialization(
        current.route,
        expectedVersion,
      );
      if (!route)
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member binding changed; refresh and retry.",
          409,
        );
      const installation = this.requireInstallation(
        route.binding!.installationId,
      );
      new DeliveryRepository(this.database).retryNativeCreation(
        agentId,
        {
          binding: route.binding!,
          installation,
          nativeSessionKey: route.nativeSessionKey!,
        },
        route.bindingVersion,
      );
      return this.view(route);
    });
  }

  public update(
    sessionId: string,
    agentId: string,
    raw: UpdateMemberRouteInput,
  ): SessionMemberRouteView {
    const input = updateMemberRouteInputSchema.parse(raw);
    return inStoreTransaction(this.database, () => {
      const current = this.get(sessionId, agentId);
      if (current.route.bindingVersion !== input.expectedBindingVersion) {
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member binding changed. Refresh before modifying it.",
          409,
        );
      }
      if (!["host", "worker", "knowledge_keeper"].includes(current.agent.role))
        throw coreErrors.invalidInput(
          "This role cannot change its delivery channel.",
        );
      if (
        this.database
          .prepare(
            "SELECT 1 FROM messages WHERE to_agent_id = ? AND processing_status IN ('pending','claimed') LIMIT 1",
          )
          .get(agentId)
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_BUSY",
          "Resolve pending or running messages before changing the member binding.",
          409,
        );
      }
      if (
        this.database
          .prepare(
            "SELECT 1 FROM message_deliveries WHERE target_agent_id = ? AND state IN ('queued','delivering','awaiting_result','blocked','unknown') LIMIT 1",
          )
          .get(agentId)
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_BUSY",
          "Resolve proxy deliveries before changing their native target.",
          409,
        );
      }
      if (
        this.database
          .prepare("SELECT 1 FROM web_agent_runtimes WHERE agent_id = ?")
          .get(agentId)
      ) {
        throw new CoreError(
          "MEMBER_ROUTE_BUSY",
          "Remove the Core runtime before changing its delivery channel.",
          409,
        );
      }
      let binding: NativeSessionBinding | null = null;
      let nativeSessionKey: string | null = null;
      let creatingNativeSession = false;
      if (input.accessMode === "managed_proxy") {
        const installation = this.requireInstallation(
          input.binding.installationId,
        );
        if (installationCompatibility(installation).status === "unavailable")
          throw coreErrors.invalidInput(
            "所选工具入口不可用，请先修复安装位置；详细原因见“发现 Worker”页面。",
          );
        const serverTool = ["mimo", "opencode"].includes(installation.toolId);
        if (!serverTool && !input.binding.runtimeNamespace.trim()) {
          throw coreErrors.invalidInput(
            "该 CLI 必须填写保存原生会话的工具数据目录。",
          );
        }
        if (serverTool && !input.binding.endpoint)
          throw coreErrors.invalidInput(
            "MiMo / OpenCode 必须填写正在运行的服务地址。",
          );
        creatingNativeSession =
          !input.binding.nativeSessionId?.trim() ||
          input.binding.nativeSessionId.startsWith("loopmarshal-pending:");
        if (
          installation.toolId === "cursor" &&
          !creatingNativeSession &&
          (current.installation?.toolId !== "cursor" ||
            current.route.binding?.nativeSessionId !==
              input.binding.nativeSessionId)
        )
          throw coreErrors.invalidInput(
            "Cursor CLI 暂只支持在本工具中新建会话，不支持导入外部聊天。",
          );
        const runtimeNamespace = serverTool
          ? ""
          : input.binding.runtimeNamespace.trim();
        binding = nativeSessionBindingSchema.parse({
          ...input.binding,
          nativeSessionId: creatingNativeSession
            ? `loopmarshal-pending:${randomUUID()}`
            : input.binding.nativeSessionId,
          workspacePath: this.canonicalPath(input.binding.workspacePath, true),
          runtimeNamespace: runtimeNamespace
            ? this.canonicalPath(runtimeNamespace, true)
            : "",
        });
        if (
          installation.toolId === "zcode" &&
          binding.runtimeNamespace &&
          basename(binding.runtimeNamespace).toLowerCase() !== ".zcode"
        ) {
          binding.runtimeNamespace = this.canonicalPath(
            join(binding.runtimeNamespace, ".zcode"),
            true,
          );
        }
        let endpointIdentity: string | null = null;
        if (binding.endpoint) {
          const endpoint = new URL(binding.endpoint);
          if (
            !["http:", "https:"].includes(endpoint.protocol) ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash
          ) {
            throw coreErrors.invalidInput(
              "Session endpoint must be HTTP(S), without credentials, query or fragment.",
            );
          }
          binding.endpoint = endpoint.href.replace(/\/$/, "");
          if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
            endpoint.hostname = "loopmarshal-loopback.invalid";
          endpointIdentity = endpoint.href.replace(/\/$/, "");
        }
        {
          const namespace =
            process.platform === "win32"
              ? binding.runtimeNamespace.toLowerCase()
              : binding.runtimeNamespace;
          nativeSessionKey = createHash("sha256")
            .update(
              JSON.stringify([
                installation.toolId,
                endpointIdentity ?? namespace,
                binding.nativeSessionId,
              ]),
            )
            .digest("hex");
        }
        if (!creatingNativeSession) {
          const occupied = this.routes.findByNativeSessionKey(nativeSessionKey);
          if (!input.disabled && occupied && occupied.agentId !== agentId) {
            throw new CoreError(
              "NATIVE_SESSION_IN_USE",
              "This native session is already bound to another member.",
              409,
            );
          }
        }
      }
      const timestamp = new Date().toISOString();
      const route: SessionMemberRoute = {
        ...current.route,
        accessMode: input.accessMode,
        bindingStatus: input.disabled
          ? "disabled"
          : input.accessMode === "managed_proxy"
            ? creatingNativeSession
              ? "initializing"
              : "blocked"
            : "ready",
        bindingVersion: current.route.bindingVersion + 1,
        binding,
        nativeSessionKey,
        verifiedAt: null,
        verifiedToolVersion: null,
        lastError:
          input.accessMode === "managed_proxy" && !creatingNativeSession
            ? "Native session verification required"
            : null,
        updatedAt: timestamp,
      };
      const changed = this.routes.update(route, input.expectedBindingVersion, {
        id: randomUUID(),
        sessionId,
        agentId,
        bindingVersion: route.bindingVersion,
        reason: input.reason,
        before: current.route,
        after: route,
        createdAt: timestamp,
      });
      if (!changed)
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Member binding changed. Refresh and retry.",
          409,
        );
      return this.view(route);
    });
  }

  public listEvents(sessionId: string, agentId: string) {
    this.get(sessionId, agentId);
    return this.routes.listEvents(agentId);
  }

  private requireInstallation(id: string): ToolInstallation {
    const installation = this.routes.getInstallation(id);
    if (!installation)
      throw new CoreError(
        "TOOL_INSTALLATION_NOT_FOUND",
        "Tool installation was not found.",
        404,
      );
    return installation;
  }

  private view(route: SessionMemberRoute): SessionMemberRouteView {
    const agent = this.agents.findById(route.agentId);
    if (!agent) throw coreErrors.agentNotFound(route.agentId);
    const installation = route.binding
      ? this.routes.getInstallation(route.binding.installationId)
      : null;
    return {
      agent,
      route,
      installation: installation
        ? {
            ...installation,
            compatibility: installationCompatibility(installation),
          }
        : null,
    };
  }

  private canonicalPath(value: string, directory: boolean): string {
    if (!isAbsolute(value))
      throw coreErrors.invalidInput("An absolute path is required.");
    try {
      const canonical = realpathSync(value);
      const stats = statSync(canonical);
      if (directory ? !stats.isDirectory() : !stats.isFile())
        throw new Error("Unexpected path type");
      return canonical;
    } catch {
      throw coreErrors.invalidInput(
        directory
          ? "Workspace/configuration directory does not exist."
          : "Tool executable does not exist.",
      );
    }
  }
}
