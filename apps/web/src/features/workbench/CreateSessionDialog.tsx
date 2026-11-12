import { Icon } from "@/components/Icon";
import { Badge, Dialog, ErrorState, Field, pushToast } from "@/components/ui";
import { api, getApiClient } from "@/lib/api-client";
import {
  createSessionSetupSchema,
  toolAvailability,
  toolCompatibility,
  type CreateSessionSetupInput,
  type NativeSessionCandidate,
  type SessionAgentSetup,
  type ToolInstallation,
} from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ToolCompatibilityNotice } from "../tools/ToolCompatibilityNotice";

const roleLabels = {
  host: "主控",
  worker: "执行者",
  knowledge_keeper: "知识库维护者",
};
const newAgent = (
  role: SessionAgentSetup["role"],
  name: string,
): SessionAgentSetup => ({
  role,
  name,
  mode: "core_runtime",
  nativeSessionMode: "create",
  duty:
    role === "host"
      ? "理解项目和目标，编排成员、维护决策并验收结果"
      : role === "knowledge_keeper"
        ? "跟进当前会话，及时核实和维护项目知识，向 Host 回报变更"
        : "阅读项目、执行分配的开发任务并验证和回报",
  modelConfigId: "",
  externalMcpServerIds: [],
  customSkillIds: [],
});

export function CreateSessionDialog({
  open,
  onClose,
  models,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  models: Array<{ id: string; name: string; modelId: string }>;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [agents, setAgents] = useState<SessionAgentSetup[]>([]);
  const [nativeSessions, setNativeSessions] = useState<
    Record<number, { sessions: NativeSessionCandidate[]; truncated: boolean }>
  >({});
  const installations = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => getApiClient().listToolInstallations(),
    enabled: open,
  });
  const toolProfiles = useQuery({
    queryKey: ["tool-config-profiles"],
    queryFn: () => getApiClient().listToolConfigProfiles(),
    enabled: open,
  });
  const mcp = useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: () => api.mcpServers.list(),
    enabled: open,
  });
  const skills = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows.list(),
    enabled: open,
  });
  useEffect(() => {
    if (models[0]?.id)
      setAgents((current) =>
        current.map((agent) =>
          agent.mode === "core_runtime" && !agent.modelConfigId
            ? { ...agent, modelConfigId: models[0]!.id }
            : agent,
        ),
      );
  }, [models]);
  useEffect(() => {
    if (!installations.data || !toolProfiles.data) return;
    setAgents((current) =>
      current.map((agent) => {
        if (agent.mode !== "managed_proxy" || !agent.binding) return agent;
        const installationId =
          agent.binding.installationId ||
          installations.data.find(
            (tool) => tool.compatibility?.status !== "unavailable",
          )?.id ||
          "";
        const profile =
          toolProfiles.data.profiles.find(
            (item) =>
              item.installationId === installationId &&
              (!item.workspacePath ||
                !project ||
                item.workspacePath === project),
          ) ??
          toolProfiles.data.profiles.find(
            (item) => item.installationId === installationId,
          );
        const selectedInstallation = installations.data.find(
          (item) => item.id === installationId,
        );
        const serverTool =
          selectedInstallation &&
          ["mimo", "opencode"].includes(selectedInstallation.toolId);
        return {
          ...agent,
          binding: {
            ...agent.binding,
            installationId,
            workspacePath: project,
            runtimeNamespace: serverTool
              ? ""
              : agent.binding.runtimeNamespace ||
                profile?.configRoot ||
                (selectedInstallation
                  ? toolProfiles.data.defaults[selectedInstallation.toolId]
                  : "") ||
                "",
          },
        };
      }),
    );
  }, [installations.data, project, toolProfiles.data]);
  useEffect(() => {
    if (open) {
      setName(`session-${new Date().toISOString().slice(0, 10)}`);
      setProject("");
      setNativeSessions({});
      setAgents([
        { ...newAgent("host", "主控"), modelConfigId: models[0]?.id ?? "" },
      ]);
      create.reset();
      scan.reset();
      register.reset();
    }
  }, [open]);
  const update = (index: number, patch: Partial<SessionAgentSetup>) =>
    setAgents((current) =>
      current.map((agent, i) => (i === index ? { ...agent, ...patch } : agent)),
    );
  const create = useMutation({
    mutationFn: async () =>
      getApiClient().createSessionSetup({
        sessionName: name,
        projectPath: project,
        agents,
      } satisfies CreateSessionSetupInput),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      onCreated(result.session.id);
      onClose();
      pushToast(
        result.warnings.length
          ? `会话已创建；${result.warnings.join("；")}`
          : "会话已创建，协作配置已生成",
        result.warnings.length ? "warning" : "success",
      );
    },
  });
  const scan = useMutation({
    mutationFn: () => getApiClient().discoverTools(),
  });
  const register = useMutation({
    mutationFn: (candidate: {
      toolId: ToolInstallation["toolId"];
      executablePath: string;
    }) =>
      getApiClient().createToolInstallation({
        ...candidate,
        displayName: candidate.toolId,
      }),
    onSuccess: () => {
      void installations.refetch();
    },
  });
  const nativeScan = useMutation({
    mutationFn: async (input: {
      index: number;
      installationId: string;
      workspacePath: string;
      runtimeNamespace: string;
    }) => ({
      index: input.index,
      result: await getApiClient().discoverNativeSessions(
        input.installationId,
        {
          workspacePath: input.workspacePath,
          runtimeNamespace: input.runtimeNamespace,
        },
      ),
    }),
    onSuccess: ({ index, result }) => {
      setNativeSessions((current) => ({ ...current, [index]: result }));
    },
  });
  const validation = createSessionSetupSchema.safeParse({
    sessionName: name,
    projectPath: project,
    agents,
  });
  const blockingReasons: string[] = [];
  if (!name.trim()) blockingReasons.push("填写会话名称");
  if (!project.trim()) blockingReasons.push("选择项目目录");
  const names = agents.map((agent) => agent.name.trim());
  if (new Set(names).size !== names.length)
    blockingReasons.push("成员名称不能重复");
  for (const agent of agents) {
    const member = agent.name.trim() || roleLabels[agent.role];
    if (!agent.name.trim())
      blockingReasons.push(`${roleLabels[agent.role]}：填写成员名称`);
    if (!agent.duty.trim()) blockingReasons.push(`${member}：填写职责`);
    if (
      agent.mode === "core_runtime" &&
      !models.some((model) => model.id === agent.modelConfigId)
    ) {
      blockingReasons.push(`${member}：选择模型配置`);
    }
    if (agent.mode === "managed_proxy") {
      const installation = installations.data?.find(
        (tool) => tool.id === agent.binding?.installationId,
      );
      if (!installation) blockingReasons.push(`${member}：选择已登记的 Worker`);
      if (installation?.compatibility?.status === "unavailable")
        blockingReasons.push(`${member}：工具入口不可用，请先修复安装位置`);
      if (
        (agent.nativeSessionMode ??
          (agent.binding?.nativeSessionId ? "existing" : "create")) ===
          "existing" &&
        !agent.binding?.nativeSessionId?.trim()
      )
        blockingReasons.push(`${member}：填写原生会话编号`);
      if (
        installation &&
        !["mimo", "opencode"].includes(installation.toolId) &&
        !agent.binding?.runtimeNamespace?.trim()
      ) {
        blockingReasons.push(`${member}：填写工具配置与会话目录`);
      }
      if (
        installation &&
        ["mimo", "opencode"].includes(installation.toolId) &&
        !agent.binding?.endpoint?.trim()
      ) {
        blockingReasons.push(`${member}：填写正在运行的服务地址`);
      }
    }
  }
  const canCreate = validation.success && blockingReasons.length === 0;
  const incompleteHint = canCreate
    ? "配置已完整，可以创建协作"
    : blockingReasons.length
      ? `还需完成：${blockingReasons.join("；")}`
      : validation.success
        ? "请检查会话配置"
        : (validation.error.issues[0]?.message ?? "请检查会话配置");
  return (
    <Dialog open={open} onClose={onClose} title="新建协作" width={1080}>
      {(installations.error ??
        toolProfiles.error ??
        mcp.error ??
        skills.error) && (
        <ErrorState
          message={
            (installations.error ??
              toolProfiles.error ??
              mcp.error ??
              skills.error)!.message
          }
          onRetry={() => {
            void installations.refetch();
            void toolProfiles.refetch();
            void mcp.refetch();
            void skills.refetch();
          }}
        />
      )}
      <div className="session-create">
        <div className="create-main">
          <section className="create-section">
            <div className="section-heading">
              <div>
                <h2>项目与会话</h2>
                <p>让所有成员在同一个项目中工作。</p>
              </div>
              <Icon name="folder" size={20} />
            </div>
            <div className="create-project-fields">
              <Field label="会话名称" required>
                <input
                  className="input"
                  aria-label="会话名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="项目目录"
                required
                hint="成员将读取这个本地项目；各会话的知识库独立保存。"
              >
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    aria-label="项目目录"
                    placeholder="例如 D:\\projects\\my-app"
                    value={project}
                    onChange={(e) => {
                      setProject(e.target.value);
                      setNativeSessions({});
                      nativeScan.reset();
                      setAgents((current) =>
                        current.map((a) =>
                          a.binding
                            ? {
                                ...a,
                                binding: {
                                  ...a.binding,
                                  workspacePath: e.target.value,
                                  nativeSessionId: "",
                                },
                              }
                            : a,
                        ),
                      );
                    }}
                  />
                  {window.loopmarshalDesktop?.selectProjectDirectory && (
                    <button
                      className="btn btn-secondary"
                      onClick={async () => {
                        const chosen =
                          await window.loopmarshalDesktop!
                            .selectProjectDirectory!();
                        if (chosen) {
                          setProject(chosen);
                          setNativeSessions({});
                          nativeScan.reset();
                          setAgents((current) =>
                            current.map((a) =>
                              a.binding
                                ? {
                                    ...a,
                                    binding: {
                                      ...a.binding,
                                      workspacePath: chosen,
                                      nativeSessionId: "",
                                    },
                                  }
                                : a,
                            ),
                          );
                        }
                      }}
                    >
                      浏览
                    </button>
                  )}
                </div>
              </Field>
            </div>
          </section>
          <div className="notice notice-success">
            <Icon name="shield" size={18} />
            <p>
              选择模型或本机 Worker 即可。协作 Skill 和消息工具将自动配置。
              已有外部 Host 可从“打开已有协作”进入。
            </p>
          </div>
          <div className="section-heading create-team-heading">
            <div>
              <h2>组建协作团队</h2>
              <p>主控必填，执行者与知识库维护者按需添加。</p>
            </div>
            <Badge>{agents.length} 位成员</Badge>
          </div>
          {agents.map((agent, index) => (
            <section
              className="card create-agent-card"
              key={index}
              aria-label={roleLabels[agent.role]}
              style={{ padding: 16, display: "grid", gap: 12 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div className="create-role-heading">
                  <span className={`agent-avatar avatar-${agent.role}`}>
                    <Icon
                      name={
                        agent.role === "host"
                          ? "workspace"
                          : agent.role === "knowledge_keeper"
                            ? "book"
                            : "terminal"
                      }
                      size={18}
                    />
                  </span>
                  <strong>{roleLabels[agent.role]}</strong>
                  <Badge variant={agent.role === "host" ? "accent" : "neutral"}>
                    {agent.role === "host" ? "必填" : "可选"}
                  </Badge>
                </div>
                {agent.role !== "host" && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setAgents((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    移除
                  </button>
                )}
              </div>
              <div className="form-grid">
                <Field label="成员名称" required>
                  <input
                    className="input"
                    aria-label={`${roleLabels[agent.role]}名称`}
                    value={agent.name}
                    onChange={(e) => update(index, { name: e.target.value })}
                  />
                </Field>
                <Field label="运行方式" required>
                  <select
                    className="input"
                    aria-label={`${roleLabels[agent.role]}运行方式`}
                    value={agent.mode}
                    onChange={(e) => {
                      const mode = e.target.value as SessionAgentSetup["mode"];
                      if (mode !== "managed_proxy") {
                        update(index, { mode });
                        return;
                      }
                      const installationId =
                        agent.binding?.installationId ??
                        installations.data?.[0]?.id ??
                        "";
                      const profile =
                        toolProfiles.data?.profiles.find(
                          (item) =>
                            item.installationId === installationId &&
                            (!item.workspacePath ||
                              !project ||
                              item.workspacePath === project),
                        ) ??
                        toolProfiles.data?.profiles.find(
                          (item) => item.installationId === installationId,
                        );
                      update(index, {
                        mode,
                        binding: {
                          installationId,
                          workspacePath: project,
                          runtimeNamespace:
                            agent.binding?.runtimeNamespace ||
                            profile?.configRoot ||
                            "",
                          nativeSessionId: agent.binding?.nativeSessionId ?? "",
                          endpoint: agent.binding?.endpoint ?? null,
                        },
                      });
                    }}
                  >
                    <option value="core_runtime">使用本地模型</option>
                    <option value="managed_proxy">使用本机 Worker</option>
                    {agent.role !== "host" && (
                      <>
                        <option value="mcp_await">
                          外部 IDE · 通过 MCP 加入
                        </option>
                        <option value="cli_await">
                          外部工具 · 通过命令加入
                        </option>
                      </>
                    )}
                  </select>
                </Field>
              </div>
              <Field label="职责" required>
                <input
                  className="input"
                  aria-label={`${roleLabels[agent.role]}职责`}
                  value={agent.duty}
                  onChange={(e) => update(index, { duty: e.target.value })}
                />
              </Field>
              <small className="managed-setup-hint">
                <Icon name="check" size={13} />
                协作 Skill、知识库工具和消息规则自动配置
              </small>
              {agent.mode === "core_runtime" && (
                <>
                  <Field label="模型配置" required>
                    <select
                      className="input"
                      aria-label={`${roleLabels[agent.role]}模型`}
                      value={agent.modelConfigId}
                      onChange={(e) =>
                        update(index, { modelConfigId: e.target.value })
                      }
                    >
                      <option value="">选择模型</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.modelId})
                        </option>
                      ))}
                    </select>
                  </Field>
                  {models.length === 0 && (
                    <p
                      role="status"
                      style={{ margin: 0, color: "var(--c-text-secondary)" }}
                    >
                      还没有模型配置，请先到“模型配置”添加，或选择本机 Worker。
                    </p>
                  )}
                  <details className="advanced-options">
                    <summary>可选：额外工具与专项 Skill</summary>
                    <div className="form-grid" style={{ marginTop: 12 }}>
                      <fieldset
                        style={{
                          border: "1px solid var(--c-border)",
                          borderRadius: 8,
                        }}
                      >
                        <legend>MCP 工具</legend>
                        <small>内置项目与协作工具默认启用</small>
                        {mcp.data
                          ?.filter((s) => s.enabled)
                          .map((server) => (
                            <label key={server.id} style={{ display: "block" }}>
                              <input
                                type="checkbox"
                                checked={agent.externalMcpServerIds?.includes(
                                  server.id,
                                )}
                                onChange={(e) =>
                                  update(index, {
                                    externalMcpServerIds: e.target.checked
                                      ? [
                                          ...(agent.externalMcpServerIds ?? []),
                                          server.id,
                                        ]
                                      : (agent.externalMcpServerIds?.filter(
                                          (id) => id !== server.id,
                                        ) ?? []),
                                  })
                                }
                              />{" "}
                              {server.name}
                            </label>
                          ))}
                      </fieldset>
                      <fieldset
                        style={{
                          border: "1px solid var(--c-border)",
                          borderRadius: 8,
                        }}
                      >
                        <legend>Skill</legend>
                        <small>默认角色职责已内置，可叠加自定义 Skill</small>
                        {skills.data
                          ?.filter((s) => s.enabled && s.role === agent.role)
                          .map((skill) => (
                            <label key={skill.id} style={{ display: "block" }}>
                              <input
                                type="checkbox"
                                checked={agent.customSkillIds?.includes(
                                  skill.id,
                                )}
                                onChange={(e) =>
                                  update(index, {
                                    customSkillIds: e.target.checked
                                      ? [
                                          ...(agent.customSkillIds ?? []),
                                          skill.id,
                                        ]
                                      : (agent.customSkillIds?.filter(
                                          (id) => id !== skill.id,
                                        ) ?? []),
                                  })
                                }
                              />{" "}
                              {skill.name}
                            </label>
                          ))}
                      </fieldset>
                    </div>
                  </details>
                </>
              )}
              {agent.mode === "managed_proxy" && (
                <>
                  <div className="binding-intro">
                    <strong>LoopMarshal 管理原生会话</strong>
                    <p>
                      默认在第一次任务到来时创建新的原生会话；需要继续历史时再选择已有会话。
                    </p>
                  </div>
                  <Field
                    label="Worker"
                    required
                    hint="选择要使用的本机 CLI。会话创建和成员绑定由 LoopMarshal 自动完成。"
                  >
                    <select
                      className="input"
                      aria-label={`${roleLabels[agent.role]} Worker`}
                      value={agent.binding?.installationId ?? ""}
                      onChange={(e) => {
                        const installationId = e.target.value;
                        const sameInstallation =
                          agent.binding?.installationId === installationId;
                        const profile =
                          toolProfiles.data?.profiles.find(
                            (item) =>
                              item.installationId === installationId &&
                              (!item.workspacePath ||
                                !project ||
                                item.workspacePath === project),
                          ) ??
                          toolProfiles.data?.profiles.find(
                            (item) => item.installationId === installationId,
                          );
                        const selectedInstallation = installations.data?.find(
                          (item) => item.id === installationId,
                        );
                        const serverTool =
                          selectedInstallation &&
                          ["mimo", "opencode"].includes(
                            selectedInstallation.toolId,
                          );
                        update(index, {
                          binding: {
                            installationId,
                            workspacePath: project,
                            runtimeNamespace: serverTool
                              ? ""
                              : (sameInstallation
                                  ? agent.binding?.runtimeNamespace
                                  : "") ||
                                profile?.configRoot ||
                                (selectedInstallation
                                  ? toolProfiles.data?.defaults[
                                      selectedInstallation.toolId
                                    ]
                                  : "") ||
                                "",
                            nativeSessionId: sameInstallation
                              ? (agent.binding?.nativeSessionId ?? "")
                              : "",
                            endpoint: sameInstallation
                              ? (agent.binding?.endpoint ?? null)
                              : null,
                          },
                        });
                        setNativeSessions((current) => {
                          const next = { ...current };
                          delete next[index];
                          return next;
                        });
                        nativeScan.reset();
                      }}
                    >
                      <option value="">选择已登记工具</option>
                      {installations.data?.map((tool) => (
                        <option
                          key={tool.id}
                          value={tool.id}
                          disabled={
                            tool.compatibility?.status === "unavailable"
                          }
                        >
                          {tool.displayName} ·{" "}
                          {toolAvailability(
                            tool.compatibility ??
                              toolCompatibility(tool.toolId),
                            agent.binding?.installationId === tool.id
                              ? agent.binding.endpoint
                              : null,
                          ).status === "available"
                            ? "可用"
                            : "不可用"}{" "}
                          · {tool.executablePath}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {(() => {
                    const selectedTool = installations.data?.find(
                      (tool) => tool.id === agent.binding?.installationId,
                    );
                    const serverTool =
                      selectedTool &&
                      ["mimo", "opencode"].includes(selectedTool.toolId);
                    const namespaceHints: Partial<
                      Record<ToolInstallation["toolId"], string>
                    > = {
                      codex:
                        "通常是 .codex；如果你在“工具配置”页建立过配置档案，这里会自动填入对应目录。",
                      claude:
                        "通常是 .claude；如果你在“工具配置”页建立过配置档案，这里会自动填入对应目录。",
                      qwen: "通常是 .qwen；如果你在“工具配置”页建立过配置档案，这里会自动填入对应目录。",
                      zcode:
                        "选择包含 .zcode 的用户目录；配置档案存在时会自动填入。",
                      gemini:
                        "选择实际的 .gemini 目录，用于读取模型配置及保存会话历史。",
                      kimi: "选择新版 Kimi Code CLI 的 .kimi-code 目录，不是旧版 .kimi。",
                      cursor:
                        "选择 Cursor CLI 的 .cursor 配置目录；仅支持在此新建的 CLI 会话。",
                      droid:
                        "选择实际的 .factory 目录，用于读取配置及保存会话。",
                      copilot:
                        "选择实际的 .copilot 目录，用于读取模型配置及会话历史。",
                    };
                    const nativeMode =
                      agent.nativeSessionMode ??
                      (agent.binding?.nativeSessionId ? "existing" : "create");
                    const fields = [
                      ...(nativeMode === "existing"
                        ? [
                            [
                              "已有会话编号",
                              "nativeSessionId",
                              "填写所选 CLI 中已经存在的会话 ID。",
                              true,
                            ] as const,
                          ]
                        : []),
                      ...(!serverTool
                        ? [
                            [
                              "工具数据目录",
                              "runtimeNamespace",
                              namespaceHints[
                                selectedTool?.toolId as ToolInstallation["toolId"]
                              ] ??
                                "此工具保存会话历史的配置目录。配置档案存在时会自动填入。",
                              true,
                            ] as const,
                          ]
                        : []),
                      ...(serverTool
                        ? [
                            [
                              "服务地址",
                              "endpoint",
                              "填写已启动的 MiMo / OpenCode 服务地址，例如 http://127.0.0.1:4096。",
                              true,
                            ] as const,
                          ]
                        : []),
                    ] as const;
                    return (
                      <>
                        {selectedTool && (
                          <ToolCompatibilityNotice
                            toolId={selectedTool.toolId}
                            compatibility={selectedTool.compatibility}
                            installationId={selectedTool.id}
                            scope="session"
                            endpoint={agent.binding?.endpoint}
                          />
                        )}
                        <div className="form-grid">
                          <Field
                            label="会话处理方式"
                            hint="默认创建新的 CLI 会话；只有要继续历史时才需要提供已有会话编号。"
                          >
                            <select
                              className="input"
                              value={nativeMode}
                              onChange={(event) =>
                                update(index, {
                                  nativeSessionMode: event.target.value as
                                    | "create"
                                    | "existing",
                                  binding: {
                                    ...agent.binding!,
                                    nativeSessionId:
                                      event.target.value === "create"
                                        ? undefined
                                        : (agent.binding?.nativeSessionId ??
                                          ""),
                                  },
                                })
                              }
                            >
                              <option value="create">
                                新建原生会话（推荐）
                              </option>
                              <option
                                value="existing"
                                disabled={selectedTool?.toolId === "cursor"}
                              >
                                接入已有原生会话
                                {selectedTool?.toolId === "cursor"
                                  ? "（Cursor 暂不支持导入）"
                                  : ""}
                              </option>
                            </select>
                          </Field>
                          {fields.map(([label, key, hint, required]) => (
                            <Field
                              key={key}
                              label={label}
                              required={required}
                              hint={hint}
                            >
                              <input
                                className="input"
                                aria-label={`${roleLabels[agent.role]}${label}`}
                                value={
                                  agent.binding?.[
                                    key as
                                      | "nativeSessionId"
                                      | "runtimeNamespace"
                                      | "endpoint"
                                  ] ?? ""
                                }
                                onChange={(e) =>
                                  (() => {
                                    if (key === "runtimeNamespace") {
                                      setNativeSessions((current) => {
                                        const next = { ...current };
                                        delete next[index];
                                        return next;
                                      });
                                      nativeScan.reset();
                                    }
                                    update(index, {
                                      binding: {
                                        installationId:
                                          agent.binding?.installationId ?? "",
                                        workspacePath: project,
                                        runtimeNamespace:
                                          agent.binding?.runtimeNamespace ?? "",
                                        nativeSessionId:
                                          agent.binding?.nativeSessionId ?? "",
                                        endpoint:
                                          agent.binding?.endpoint ?? null,
                                        [key!]:
                                          e.target.value ||
                                          (key === "endpoint" ? null : ""),
                                      },
                                    });
                                  })()
                                }
                              />
                            </Field>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                  {(() => {
                    const selectedTool = installations.data?.find(
                      (tool) => tool.id === agent.binding?.installationId,
                    );
                    const nativeMode =
                      agent.nativeSessionMode ??
                      (agent.binding?.nativeSessionId ? "existing" : "create");
                    const canScan = Boolean(
                      selectedTool &&
                        nativeMode === "existing" &&
                        project.trim() &&
                        agent.binding?.runtimeNamespace?.trim() &&
                        !["mimo", "opencode"].includes(selectedTool.toolId),
                    );
                    const discovery = nativeSessions[index];
                    if (nativeMode === "create")
                      return (
                        <small className="managed-setup-hint">
                          LoopMarshal
                          会在第一次任务发送时创建并记录新的原生会话。
                        </small>
                      );
                    if (
                      selectedTool &&
                      ["mimo", "opencode"].includes(selectedTool.toolId)
                    ) {
                      return (
                        <small className="managed-setup-hint">
                          服务型工具暂不支持本地会话记录扫描，请从该工具的会话列表复制已有会话编号。
                        </small>
                      );
                    }
                    return (
                      <div className="native-session-picker">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!canScan || nativeScan.isPending}
                          onClick={() => {
                            if (!agent.binding || !selectedTool) return;
                            nativeScan.mutate({
                              index,
                              installationId: selectedTool.id,
                              workspacePath: project,
                              runtimeNamespace:
                                agent.binding.runtimeNamespace ?? "",
                            });
                          }}
                        >
                          <Icon name="search" size={14} />
                          {nativeScan.isPending &&
                          nativeScan.variables?.index === index
                            ? "查找中…"
                            : "查找项目中的已有会话"}
                        </button>
                        {!canScan && (
                          <small>
                            先选择工具、项目目录和工具数据目录后才能查找。
                          </small>
                        )}
                        {nativeScan.error &&
                          nativeScan.variables?.index === index && (
                            <small
                              role="alert"
                              className="native-session-error"
                            >
                              {nativeScan.error.message}
                            </small>
                          )}
                        {discovery &&
                          (discovery.sessions.length ? (
                            <>
                              <label
                                className="field-label"
                                htmlFor={`native-session-${index}`}
                              >
                                找到的原生会话
                              </label>
                              <select
                                id={`native-session-${index}`}
                                className="input"
                                value={agent.binding?.nativeSessionId ?? ""}
                                onChange={(event) =>
                                  update(index, {
                                    binding: {
                                      ...agent.binding!,
                                      nativeSessionId: event.target.value,
                                    },
                                  })
                                }
                              >
                                <option value="">
                                  选择一个会话，或继续手填编号
                                </option>
                                {discovery.sessions.map((session) => (
                                  <option key={session.id} value={session.id}>
                                    {session.id}
                                    {session.updatedAt
                                      ? ` · ${new Date(session.updatedAt).toLocaleString()}`
                                      : ""}
                                  </option>
                                ))}
                              </select>
                              {discovery.truncated && (
                                <small>
                                  仅显示最近 500
                                  个会话，请缩小工具数据目录后重试。
                                </small>
                              )}
                            </>
                          ) : (
                            <small>
                              {discovery.truncated
                                ? "最近 500 个记录中未找到匹配会话；请缩小工具数据目录后重试，或手动填写会话编号。"
                                : "没有找到与当前项目匹配的原生会话。请先在 CLI 中打开该项目并创建一轮会话。"}
                            </small>
                          ))}
                      </div>
                    );
                  })()}
                </>
              )}
              {["mcp_await", "cli_await"].includes(agent.mode) && (
                <small>
                  先登记身份，外部 IDE / CLI 再以同一会话名称、成员名称及角色
                  attach 加入。登记不代表外部程序已经启动。
                </small>
              )}
            </section>
          ))}
          <div className="create-add-members">
            <button
              className="btn btn-secondary"
              onClick={() =>
                setAgents([
                  ...agents,
                  {
                    ...newAgent(
                      "worker",
                      `开发者${agents.filter((a) => a.role === "worker").length + 1}`,
                    ),
                    modelConfigId: models[0]?.id ?? "",
                  },
                ])
              }
            >
              <Icon name="plus" size={14} />
              添加 Worker
            </button>
            {!agents.some((a) => a.role === "knowledge_keeper") && (
              <button
                className="btn btn-secondary"
                onClick={() =>
                  setAgents([
                    ...agents,
                    {
                      ...newAgent("knowledge_keeper", "知识库维护者"),
                      modelConfigId: models[0]?.id ?? "",
                    },
                  ])
                }
              >
                <Icon name="book" size={14} />
                添加知识库维护者
              </button>
            )}
            <button
              className="btn btn-ghost"
              disabled={scan.isPending}
              onClick={() => scan.mutate()}
            >
              发现 Worker
            </button>
          </div>
          {scan.data && (
            <div>
              {scan.data.candidates
                .filter(
                  (c) =>
                    !installations.data?.some(
                      (i) => i.executablePath === c.executablePath,
                    ),
                )
                .map((c) => (
                  <div key={c.executablePath}>
                    {c.toolId} · {c.executablePath}{" "}
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={register.isPending}
                      onClick={() => register.mutate(c)}
                    >
                      登记工具
                    </button>
                  </div>
                ))}
              <small>没有找到的工具可在“发现 Worker”中手动添加。</small>
            </div>
          )}
          {(create.error ?? scan.error ?? register.error) && (
            <p role="alert" style={{ color: "var(--c-error)" }}>
              {(create.error ?? scan.error ?? register.error)?.message}
            </p>
          )}
        </div>
        <aside className="create-summary">
          <div className="create-summary-icon">
            <Icon name="workspace" size={24} />
          </div>
          <h3>本次协作</h3>
          <p>先确定项目和主控，其他成员可以按需加入。</p>
          <div className="create-summary-project">
            <Icon name="folder" size={16} />
            <div>
              <strong>{name || "未命名会话"}</strong>
              <small>{project || "等待选择项目目录"}</small>
            </div>
          </div>
          <div className="create-summary-members">
            {agents.map((agent, index) => (
              <div key={index}>
                <span className={`agent-avatar avatar-${agent.role}`}>
                  <Icon
                    name={
                      agent.role === "host"
                        ? "workspace"
                        : agent.role === "knowledge_keeper"
                          ? "book"
                          : "terminal"
                    }
                    size={15}
                  />
                </span>
                <span>
                  <strong>{agent.name || "未填写名称"}</strong>
                  <small>
                    {agent.mode === "core_runtime"
                      ? (models.find(
                          (model) => model.id === agent.modelConfigId,
                        )?.name ?? "待选择模型")
                      : agent.mode === "managed_proxy"
                        ? agent.nativeSessionMode === "existing"
                          ? "接续已有 CLI 会话"
                          : "LoopMarshal 将创建 CLI 会话"
                        : "外部成员"}
                  </small>
                </span>
              </div>
            ))}
          </div>
          <div className="create-summary-footer">
            <Icon name="check" size={15} />
            <span>独立会话知识库</span>
            <Icon name="check" size={15} />
            <span>自动配置协作能力</span>
            <Icon name="check" size={15} />
            <span>保留 Worker 中的会话历史</span>
          </div>
        </aside>
      </div>
      <div className="create-footer">
        <span role={canCreate ? "status" : "alert"}>{incompleteHint}</span>
        <div>
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={create.isPending}
            aria-disabled={!canCreate}
            onClick={() => {
              if (!canCreate) {
                pushToast(incompleteHint, "warning");
                return;
              }
              create.mutate();
            }}
          >
            {create.isPending
              ? "准备成员中…"
              : canCreate
                ? "创建协作"
                : "检查配置"}
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
