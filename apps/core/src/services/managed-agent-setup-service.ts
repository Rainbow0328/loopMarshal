import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ManagedAgentSetup } from "@loopmarshal/protocol";
import type { ServerServices } from "../server/create-server.js";
import { coreErrors } from "../errors.js";
import {
  managedCollaborationSkill,
  managedSkillVersion,
  managedToolNames,
} from "./managed-collaboration-skill.js";
import { managedMemberBridgeSource } from "./managed-member-bridge.js";

const key = (id: string) => createHash("sha256").update(id).digest("hex");
/** Member-specific files belong to LoopMarshal; no vendor-global or project configuration is overwritten. */
export class ManagedAgentSetupService {
  private readonly root: string;
  constructor(
    databasePath: string,
    private readonly services: () => ServerServices,
    private readonly baseUrl: () => string,
  ) {
    this.root = join(dirname(resolve(databasePath)), "agent-setups");
  }
  private directory(sessionId: string, agentId: string) {
    return join(this.root, key(sessionId), key(agentId));
  }
  private check(path: string): void {
    let current = resolve(path);
    for (;;) {
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat) {
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
          throw coreErrors.invalidInput("自动配置目录包含链接，无法写入。");
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  private write(path: string, content: string): void {
    this.check(path);
    mkdirSync(dirname(path), { recursive: true });
    this.check(path);
    if (existsSync(path) && readFileSync(path, "utf8") === content) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  public ensure(sessionId: string, agentId: string): ManagedAgentSetup {
    const services = this.services();
    const session = services.sessionService.getSession(sessionId);
    const member = services.memberRouteService!.get(sessionId, agentId);
    const { agent, route, installation } = member;
    if (!["host", "worker", "knowledge_keeper"].includes(agent.role))
      throw coreErrors.invalidInput("该成员无需协作执行配置。");
    const directory = this.directory(sessionId, agentId);
    this.check(directory);
    const connectionPath = join(directory, "connection.json");
    this.check(connectionPath);
    let token: string | undefined;
    if (existsSync(connectionPath)) {
      try {
        const previous = JSON.parse(readFileSync(connectionPath, "utf8"));
        const credential = services.memberCredentialService!.authenticate(
          previous.token,
        );
        if (
          credential.sessionId === sessionId &&
          credential.agentId === agentId &&
          credential.label === "managed-agent:collaboration"
        )
          token = previous.token;
      } catch {
        /* Revoked or obsolete managed credentials are regenerated automatically. */
      }
    }
    if (!token) {
      for (const credential of services.memberCredentialService!.list(
        sessionId,
        agentId,
      )) {
        if (
          credential.label === "managed-agent:collaboration" &&
          !credential.revokedAt
        )
          services.memberCredentialService!.revoke(
            sessionId,
            agentId,
            credential.id,
          );
      }
    }
    const issued = token
      ? null
      : services.memberCredentialService!.issue(
          sessionId,
          agentId,
          "managed-agent:collaboration",
        );
    token ??= issued!.token;
    try {
      const names = managedToolNames(agent.role, route.accessMode);
      const tools = services.mcpToolService
        .getToolDefinitionsByNames(names)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        }));
      const serverName = `loopmarshal_${key(agentId).slice(0, 12)}`;
      const bridgePath = join(directory, "member-tools.cjs");
      const skillPath = join(
        directory,
        "skills",
        "loopmarshal-role",
        "SKILL.md",
      );
      const mcpConfigPath = join(directory, "mcp.json");
      const transport =
        route.accessMode === "core_runtime"
          ? "in_process"
          : installation && ["codex", "claude"].includes(installation.toolId)
            ? "native_mcp"
            : route.accessMode === "managed_proxy"
              ? "command_bridge"
              : "external_mcp";
      const manifest: ManagedAgentSetup = {
        sessionId,
        agentId,
        role: agent.role as ManagedAgentSetup["role"],
        accessMode: route.accessMode,
        status: "ready",
        skillVersion: managedSkillVersion,
        serverName,
        skillPath,
        mcpConfigPath,
        bridgePath,
        transport,
        tools: names,
      };
      const skill =
        managedCollaborationSkill(agent.role, route.accessMode) +
        `\n# Bound identity\nSession: ${session.name} (${sessionId})\nMember: ${agent.agentName} (${agentId})\nDuty: ${agent.roleDescription ?? ""}\nProject: ${session.projectPath ?? route.binding?.workspacePath ?? "Not set"}\n`;
      this.write(bridgePath, managedMemberBridgeSource);
      this.write(skillPath, skill);
      this.write(
        join(directory, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: serverName.replaceAll("_", "-"),
            version: "1.0.0",
            description: "LoopMarshal managed member collaboration Skill",
          },
          null,
          2,
        ),
      );
      this.write(
        mcpConfigPath,
        JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                command: process.execPath,
                args: [bridgePath, "--mcp"],
              },
            },
          },
          null,
          2,
        ),
      );
      this.write(
        connectionPath,
        JSON.stringify({
          sessionId,
          agentId,
          baseUrl: this.baseUrl(),
          token,
          tools,
        }),
      );
      this.write(
        join(directory, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      return manifest;
    } catch (error) {
      if (issued)
        services.memberCredentialService!.revoke(
          sessionId,
          agentId,
          issued.credential.id,
        );
      throw error;
    }
  }
  public syncSession(sessionId: string): ManagedAgentSetup[] {
    const members = this.services()
      .sessionService.listMembers(sessionId)
      .filter((agent) =>
        ["host", "worker", "knowledge_keeper"].includes(agent.role),
      );
    const parent = join(this.root, key(sessionId));
    this.check(parent);
    if (existsSync(parent))
      for (const entry of readdirSync(parent)) {
        if (
          /^[a-f0-9]{64}$/.test(entry) &&
          !members.some((agent) => key(agent.id) === entry)
        )
          this.removeOwned(join(parent, entry));
      }
    return members.map((agent) => this.ensure(sessionId, agent.id));
  }
  private removeOwned(path: string): void {
    if (
      !resolve(path).startsWith(
        resolve(this.root) + (process.platform === "win32" ? "\\" : "/"),
      )
    )
      throw new Error("Unexpected managed configuration path");
    this.check(path);
    const inspect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        this.check(child);
        if (entry.isDirectory()) inspect(child);
      }
    };
    if (existsSync(path)) {
      inspect(path);
      rmSync(path, { recursive: true, force: true });
    }
  }
  public reconcile(): void {
    const sessions = this.services().sessionService.listSessions();
    this.check(this.root);
    if (existsSync(this.root))
      for (const entry of readdirSync(this.root)) {
        if (
          /^[a-f0-9]{64}$/.test(entry) &&
          !sessions.some((session) => key(session.id) === entry)
        )
          this.removeOwned(join(this.root, entry));
      }
    for (const session of sessions) this.syncSession(session.id);
  }
  public removeSession(sessionId: string): void {
    this.removeOwned(join(this.root, key(sessionId)));
  }
  public read(sessionId: string, agentId: string): ManagedAgentSetup | null {
    const path = join(this.directory(sessionId, agentId), "manifest.json");
    this.check(path);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }
}
