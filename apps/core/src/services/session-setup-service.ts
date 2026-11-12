import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionSetupInput,
  UpdateMemberRouteInput,
} from "@loopmarshal/protocol";
import type { ServerServices } from "../server/create-server.js";
import { projectKnowledgePolicy } from "./project-knowledge-policy.js";
import { coreErrors } from "../errors.js";

export async function createSessionSetup(
  services: ServerServices,
  input: CreateSessionSetupInput,
) {
  const host = input.agents.find((agent) => agent.role === "host");
  if (!host || !["core_runtime", "managed_proxy"].includes(host.mode))
    throw coreErrors.invalidInput(
      "客户端创建会话必须配置本地模型或代理 CLI 作为 Host。",
    );
  // Preflight every selection before creating any session state.
  for (const agent of input.agents) {
    if (agent.mode === "core_runtime") {
      if (
        !agent.modelConfigId?.trim() ||
        !services.modelConfigService.findById(agent.modelConfigId)
      )
        throw coreErrors.invalidInput("请选择存在的本地模型配置。");
      services.modelConfigService.getFull(agent.modelConfigId!);
      for (const id of agent.customSkillIds ?? []) {
        const skill = services.workflowDefinitionService.get(id);
        if (!skill.enabled || skill.role !== agent.role)
          throw coreErrors.invalidInput("所选 Skill 不适用于该角色。");
      }
      for (const id of agent.externalMcpServerIds ?? []) {
        if (
          !services.externalMcpService
            .list()
            .some((server) => server.id === id && server.enabled)
        )
          throw coreErrors.invalidInput("所选 MCP 服务不存在或未启用。");
      }
    }
    if (agent.mode === "managed_proxy" && agent.binding) {
      try {
        const a = realpathSync(agent.binding.workspacePath);
        const b = realpathSync(input.projectPath);
        if (
          process.platform === "win32"
            ? a.toLowerCase() !== b.toLowerCase()
            : a !== b
        )
          throw new Error();
      } catch {
        throw coreErrors.invalidInput("原生会话必须绑定到本会话所选项目目录。");
      }
    }
  }
  const result = services.sessionService.transaction(() => {
    const created = services.sessionService.createSession({
      sessionName: input.sessionName,
      projectPath: input.projectPath,
      agentName: host.name,
      displayName: host.name,
      roleDescription: host.duty,
      platform: "generic",
      capabilities: [],
      connectionMode: "skill-bridge",
    });
    const members = input.agents.map((selection) => {
      const agent =
        selection.role === "host"
          ? created.agent
          : services.sessionService.joinSession({
              sessionId: created.session.id,
              agentName: selection.name,
              displayName: selection.name,
              role: selection.role,
              roleDescription: selection.duty,
              platform: "generic",
              capabilities: [],
              connectionMode: "skill-bridge",
            }).agent;
      if (selection.mode === "core_runtime") {
        services.webAgentRuntimeService.createOrUpdate({
          sessionId: created.session.id,
          agentId: agent.id,
          role: selection.role,
          modelConfigId: selection.modelConfigId!,
          toolsetId: selection.role === "worker" ? "developer" : selection.role,
          customDuty: selection.duty,
          customSkillIds: selection.customSkillIds ?? [],
          externalMcpServerIds: selection.externalMcpServerIds ?? [],
        });
      } else {
        const creatingNativeSession =
          selection.mode === "managed_proxy" &&
          (selection.nativeSessionMode ??
            (selection.binding?.nativeSessionId ? "existing" : "create")) ===
            "create";
        const binding =
          selection.mode === "managed_proxy"
            ? {
                ...selection.binding!,
                nativeSessionId:
                  selection.binding?.nativeSessionId?.trim() ||
                  `loopmarshal-pending:${randomUUID()}`,
              }
            : undefined;
        const routeInput: UpdateMemberRouteInput =
          selection.mode === "managed_proxy"
            ? {
                accessMode: "managed_proxy",
                binding: binding!,
                expectedBindingVersion: 1,
                reason: creatingNativeSession
                  ? "首次任务时创建原生会话"
                  : "会话创建时配置成员",
              }
            : {
                accessMode: selection.mode,
                expectedBindingVersion: 1,
                reason: "会话创建时配置成员",
              };
        const route = services.memberRouteService!.update(
          created.session.id,
          agent.id,
          routeInput,
        );
        if (creatingNativeSession)
          services.memberRouteService!.markInitializing(
            created.session.id,
            agent.id,
            route.route.bindingVersion,
          );
      }
      return agent;
    });
    // Project goals are not known at registration; routing metadata stays in session context.
    return { ...created, members };
  });
  const warnings: string[] = [];
  services.managedAgentSetupService?.syncSession(result.session.id);
  for (const member of result.members) {
    const route = services.memberRouteService!.get(
      result.session.id,
      member.id,
    ).route;
    if (
      route.accessMode === "managed_proxy" &&
      route.bindingStatus !== "initializing"
    ) {
      try {
        await services.proxyDeliveryService!.verify(
          result.session.id,
          member.id,
          route.bindingVersion,
        );
      } catch (error) {
        warnings.push(
          `${member.agentName}：${error instanceof Error ? error.message : "原生会话验证失败"}`,
        );
      }
    }
  }
  for (const runtime of services.webAgentRuntimeService.list(
    result.session.id,
  )) {
    const running = services.webAgentRuntimeService.setStatus(
      runtime.id,
      "running",
    );
    services.webAgentRuntimeExecutorService.start(running);
  }
  const keeper = result.members.find(
    (member) => member.role === "knowledge_keeper",
  );
  if (keeper) {
    const hostMember = result.members.find((member) => member.role === "host")!;
    services.messageService.sendMessage({
      sessionId: result.session.id,
      fromAgentId: hostMember.id,
      toAgentId: keeper.id,
      type: "task",
      idempotencyKey: `knowledge-kickoff:${result.session.id}:${keeper.id}`,
      payload: {
        kind: "knowledge_initial_review.v1",
        content: `Inspect the selected project source and existing knowledge. Record only durable, verified project facts using the hierarchy below. L1 may stay empty until the user or Host confirms the goal; do not infer direction from the session name, member setup or test task. Report missing intent as a question to the Host. No documents are required when there are no supported facts.\n\n${projectKnowledgePolicy}`,
      },
    });
  }
  return { ...result, warnings };
}
