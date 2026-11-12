import { Icon } from "@/components/Icon";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
} from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import {
  proxyToolIds,
  toolAvailability,
  toolCompatibility,
  toolEnvironmentKeys,
  toolNames,
  type NativeSessionBinding,
  type ProxyToolId,
  type SessionMemberRouteView,
  type UpdateMemberRouteInput,
} from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { invalidateSession } from "./workbench-queries";

import { ToolCompatibilityNotice } from "../tools/ToolCompatibilityNotice";

import { DeliveryDetails } from "./DeliveryDetailsDialog";
import { MemberCredentials } from "./MemberCredentials";

const accessLabels = {
  managed_proxy: "工具代理",
  mcp_await: "MCP 等待接入",
  cli_await: "CLI 等待接入",
  core_runtime: "内置运行",
};
const statusLabels = {
  initializing: "初始化中",
  ready: "已就绪",
  blocked: "待处理",
  disabled: "已停用",
};
const deliveryLabels = {
  queued: "排队中",
  delivering: "准备执行",
  awaiting_result: "正在执行",
  completed: "已回报，待 Host 验收",
  failed: "执行失败",
  blocked: "需要处理",
  unknown: "执行结果待核对",
  cancelled: "已取消",
  superseded: "已合并到后续任务",
};

export function MemberRoutesPanel({
  sessionId,
  opened,
  onOpenedChange: setOpened,
}: {
  sessionId: string;
  opened: boolean;
  onOpenedChange: (open: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<"members" | "add" | "deliveries">(
    "members",
  );
  const [toolId, setToolId] = useState<ProxyToolId>("codex");
  const [executablePath, setExecutablePath] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [memberRole, setMemberRole] = useState<"worker" | "knowledge_keeper">(
    "worker",
  );
  const [nativeMode, setNativeMode] = useState<"create" | "existing">("create");
  const [workspacePath, setWorkspacePath] = useState("");
  const [runtimeNamespace, setRuntimeNamespace] = useState("");
  const [nativeSessionId, setNativeSessionId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [environmentKeys, setEnvironmentKeys] = useState<string[]>([]);
  const [executableArgs, setExecutableArgs] = useState("");
  const [zcodeMode, setZcodeMode] =
    useState<NonNullable<NativeSessionBinding["zcodeMode"]>>("build");
  const [editing, setEditing] = useState<SessionMemberRouteView | null>(null);
  const [accessMode, setAccessMode] = useState<
    "managed_proxy" | "mcp_await" | "cli_await"
  >("managed_proxy");
  const [reason, setReason] = useState("");
  const qc = useQueryClient();
  const installations = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => getApiClient().listToolInstallations(),
    enabled: opened,
  });
  const routes = useQuery({
    queryKey: ["member-routes", sessionId],
    queryFn: () => getApiClient().listMemberRoutes(sessionId),
    enabled: opened,
    refetchInterval: opened ? 5000 : false,
  });
  const addInstallation = useMutation({
    mutationFn: () =>
      getApiClient().createToolInstallation({
        toolId,
        displayName: toolId,
        executablePath,
        environmentKeys,
        executableArgs: executableArgs.split(/\r?\n/).filter(Boolean),
      }),
    onSuccess: (installation) => {
      setInstallationId(installation.id);
      void qc.invalidateQueries({ queryKey: ["tool-installations"] });
    },
  });
  const addMember = useMutation({
    mutationFn: () => {
      const binding = {
        installationId,
        workspacePath,
        runtimeNamespace,
        ...(nativeMode === "existing" ? { nativeSessionId } : {}),
        endpoint: endpoint || null,
        ...(installations.data?.find((item) => item.id === installationId)
          ?.toolId === "zcode"
          ? { zcodeMode }
          : {}),
      };
      return editing
        ? getApiClient().updateMemberRoute(sessionId, editing.agent.id, {
            accessMode,
            expectedBindingVersion: editing.route.bindingVersion,
            reason,
            ...(accessMode === "managed_proxy" ? { binding } : {}),
          } as UpdateMemberRouteInput)
        : accessMode === "managed_proxy"
          ? getApiClient().createProxyMember(sessionId, {
              agentName,
              role: memberRole,
              roleDescription,
              binding,
            })
          : getApiClient().createAwaitMember(sessionId, {
              agentName,
              role: memberRole,
              roleDescription,
              accessMode,
            });
    },
    onSuccess: () => {
      setActiveTab("members");
      setEditing(null);
      setAccessMode("managed_proxy");
      setAgentName("");
      setMemberRole("worker");
      setNativeMode("create");
      setNativeSessionId("");
      void qc.invalidateQueries({ queryKey: ["member-routes", sessionId] });
      invalidateSession(qc, sessionId);
    },
  });
  const toggleMember = useMutation({
    mutationFn: ({ agent, route }: SessionMemberRouteView) =>
      getApiClient().updateMemberRoute(sessionId, agent.id, {
        accessMode: route.accessMode,
        expectedBindingVersion: route.bindingVersion,
        disabled: route.bindingStatus !== "disabled",
        reason:
          route.bindingStatus === "disabled"
            ? "用户重新启用成员"
            : "用户停用成员",
        ...(route.accessMode === "managed_proxy"
          ? { binding: route.binding! }
          : {}),
      } as UpdateMemberRouteInput),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["member-routes", sessionId] });
      invalidateSession(qc, sessionId);
    },
  });
  const editMember = (member: SessionMemberRouteView) => {
    setActiveTab("add");
    setEditing(member);
    setAgentName(member.agent.agentName);
    setRoleDescription(member.agent.roleDescription ?? "");
    setAccessMode(
      member.route.accessMode === "mcp_await"
        ? "mcp_await"
        : member.route.accessMode === "cli_await"
          ? "cli_await"
          : "managed_proxy",
    );
    setInstallationId(member.route.binding?.installationId ?? "");
    setWorkspacePath(member.route.binding?.workspacePath ?? "");
    setRuntimeNamespace(member.route.binding?.runtimeNamespace ?? "");
    setNativeSessionId(member.route.binding?.nativeSessionId ?? "");
    setMemberRole(
      member.agent.role === "knowledge_keeper" ? "knowledge_keeper" : "worker",
    );
    setNativeMode(
      member.route.binding?.nativeSessionId?.startsWith("loopmarshal-pending:")
        ? "create"
        : "existing",
    );
    setEndpoint(member.route.binding?.endpoint ?? "");
    setReason("");
    setZcodeMode(member.route.binding?.zcodeMode ?? "build");
  };
  const verify = useMutation({
    mutationFn: (input: { agentId: string; version: number }) =>
      getApiClient().verifyMemberRoute(sessionId, input.agentId, input.version),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["member-routes", sessionId] });
      invalidateSession(qc, sessionId);
    },
  });
  const retryCreation = useMutation({
    mutationFn: (member: SessionMemberRouteView) =>
      getApiClient().retryNativeSessionCreation(
        sessionId,
        member.agent.id,
        member.route.bindingVersion,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["member-routes", sessionId] });
      void qc.invalidateQueries({ queryKey: ["deliveries", sessionId] });
      invalidateSession(qc, sessionId);
    },
  });
  const deliveries = useQuery({
    queryKey: ["deliveries", sessionId],
    queryFn: () => getApiClient().listDeliveries(sessionId),
    enabled: opened,
    refetchInterval: opened ? 3000 : false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => getApiClient().cancelDelivery(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deliveries", sessionId] });
      invalidateSession(qc, sessionId);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    addMember.mutate();
  };
  const error =
    routes.error ??
    installations.error ??
    deliveries.error ??
    addInstallation.error ??
    addMember.error ??
    verify.error ??
    cancel.error ??
    toggleMember.error;
  const selectedInstallation =
    installations.data?.find((item) => item.id === installationId) ??
    editing?.installation ??
    null;
  const selectedServerTool = selectedInstallation
    ? ["mimo", "opencode"].includes(selectedInstallation.toolId)
    : false;

  return (
    <>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setOpened(true)}
      >
        <Icon name="plug" size={15} />
        查看绑定
      </button>
      <Dialog
        open={opened}
        onClose={() => setOpened(false)}
        title="成员绑定与接入"
        width={1000}
      >
        <div className="member-access">
          <div className="segmented-tabs" role="tablist" aria-label="成员设置">
            <button
              role="tab"
              aria-selected={activeTab === "members"}
              onClick={() => setActiveTab("members")}
            >
              当前成员
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "add"}
              onClick={() => setActiveTab("add")}
            >
              添加与调整
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "deliveries"}
              onClick={() => setActiveTab("deliveries")}
            >
              投递记录
            </button>
          </div>
          {error && <ErrorState message={error.message} />}
          {activeTab === "members" && (
            <div className="member-route-list" role="tabpanel">
              {routes.isLoading ? (
                <Loading />
              ) : !routes.data?.length ? (
                <EmptyState title="暂无成员" />
              ) : (
                routes.data.map((member) => {
                  const { agent, route, installation } = member;
                  const pendingNative =
                    route.accessMode === "managed_proxy" &&
                    Boolean(
                      route.binding?.nativeSessionId.startsWith(
                        "loopmarshal-pending:",
                      ),
                    );
                  return (
                    <section className="member-route-card" key={agent.id}>
                      <div className="member-route-heading">
                        <span className={`agent-avatar avatar-${agent.role}`}>
                          <Icon
                            name={
                              agent.role === "host"
                                ? "workspace"
                                : agent.role === "knowledge_keeper"
                                  ? "book"
                                  : "terminal"
                            }
                            size={20}
                          />
                        </span>
                        <div>
                          <strong>{agent.agentName}</strong>
                          <p>{agent.roleDescription}</p>
                        </div>
                        <Badge
                          variant={
                            route.accessMode === "mcp_await" ||
                            route.accessMode === "cli_await"
                              ? "neutral"
                              : route.bindingStatus === "ready"
                                ? "success"
                                : route.bindingStatus === "blocked"
                                  ? "warning"
                                  : "neutral"
                          }
                          dot
                        >
                          {route.accessMode === "mcp_await" ||
                          route.accessMode === "cli_await"
                            ? "已登记身份"
                            : statusLabels[route.bindingStatus]}
                        </Badge>
                      </div>
                      <div className="member-route-facts">
                        <div>
                          <span>接入方式</span>
                          <strong>{accessLabels[route.accessMode]}</strong>
                        </div>
                        <div>
                          <span>编程工具</span>
                          <strong>
                            {installation?.displayName ??
                              (route.accessMode === "core_runtime"
                                ? "本地模型 Agent"
                                : "外部工具")}
                          </strong>
                        </div>
                        {route.binding && !pendingNative && (
                          <div className="native-session-fact">
                            <span>原生会话</span>
                            <code>{route.binding.nativeSessionId}</code>
                          </div>
                        )}
                        {pendingNative && (
                          <div className="native-session-fact">
                            <span>原生会话</span>
                            <strong>首次派发时创建</strong>
                          </div>
                        )}
                      </div>
                      {route.lastError && (
                        <ErrorState message={route.lastError} />
                      )}
                      <div className="member-route-actions">
                        {route.accessMode === "managed_proxy" &&
                          !pendingNative &&
                          route.bindingStatus !== "disabled" && (
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={verify.isPending}
                              onClick={() =>
                                verify.mutate({
                                  agentId: agent.id,
                                  version: route.bindingVersion,
                                })
                              }
                            >
                              验证会话
                            </button>
                          )}
                        {pendingNative &&
                          route.bindingStatus === "initializing" && (
                            <small>
                              首次派发任务时由 LoopMarshal 创建原生会话。
                            </small>
                          )}
                        {pendingNative &&
                          route.bindingStatus === "blocked" &&
                          !(deliveries.data ?? []).some(
                            (item) =>
                              item.targetAgentId === agent.id &&
                              item.state === "unknown",
                          ) && (
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={retryCreation.isPending}
                              onClick={() => retryCreation.mutate(member)}
                            >
                              重试创建原生会话
                            </button>
                          )}
                        {route.accessMode !== "core_runtime" && (
                          <>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => editMember(member)}
                            >
                              接入设置
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={toggleMember.isPending}
                              onClick={() => toggleMember.mutate(member)}
                            >
                              {route.bindingStatus === "disabled"
                                ? "启用"
                                : "停用"}
                            </button>
                          </>
                        )}
                      </div>
                      <details className="member-route-details">
                        <summary>连接信息与高级设置</summary>
                        {route.binding && (
                          <div className="route-binding-detail">
                            <p>项目：{route.binding.workspacePath}</p>
                            <p>工具数据：{route.binding.runtimeNamespace}</p>
                            <p>服务：{route.binding.endpoint ?? "本机命令"}</p>
                            <p>上次验证：{route.verifiedAt ?? "尚未验证"}</p>
                            <p>
                              绑定版本：{route.bindingVersion} / 工具版本：
                              {route.verifiedToolVersion ?? "未验证"}
                            </p>
                          </div>
                        )}
                        <MemberCredentials
                          sessionId={sessionId}
                          agentId={agent.id}
                        />
                      </details>
                    </section>
                  );
                })
              )}
            </div>
          )}
          {activeTab === "add" && (
            <div className="member-add-panel" role="tabpanel">
              <div className="notice">
                <Icon name="info" size={18} />
                <p>
                  添加一个 Worker，创建新的 CLI
                  会话、接续已有会话，或等待外部工具加入。协作 Skill
                  和成员工具由系统自动配置。
                </p>
              </div>
              <details>
                <summary>添加工具安装位置</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    addInstallation.mutate();
                  }}
                  style={{
                    display: "grid",
                    gap: "var(--sp-2)",
                    marginTop: "var(--sp-2)",
                  }}
                >
                  <Field label="编程工具">
                    <select
                      className="input"
                      value={toolId}
                      onChange={(event) => {
                        setToolId(event.target.value as ProxyToolId);
                        setEnvironmentKeys([]);
                      }}
                    >
                      {proxyToolIds.map((id) => (
                        <option key={id} value={id}>
                          {toolNames[id]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ToolCompatibilityNotice toolId={toolId} />
                  <Field label="可执行文件的完整路径">
                    <input
                      className="input"
                      required
                      value={executablePath}
                      onChange={(event) =>
                        setExecutablePath(event.target.value)
                      }
                    />
                  </Field>
                  <Field label="固定启动参数（可选，每行一项）">
                    <textarea
                      className="input"
                      value={executableArgs}
                      onChange={(event) =>
                        setExecutableArgs(event.target.value)
                      }
                      placeholder="例如 Qwen 的 --bare，请勿填写密钥"
                    />
                  </Field>
                  {toolEnvironmentKeys[toolId].length > 0 && (
                    <details>
                      <summary>从 Core 环境读取模型配置（可选）</summary>
                      <p>仅保存勾选的变量名。值由启动 Core 的环境提供。</p>
                      {toolEnvironmentKeys[toolId].map((key) => (
                        <label key={key} style={{ display: "block" }}>
                          <input
                            type="checkbox"
                            checked={environmentKeys.includes(key)}
                            onChange={(event) =>
                              setEnvironmentKeys((keys) =>
                                event.target.checked
                                  ? [...keys, key]
                                  : keys.filter((item) => item !== key),
                              )
                            }
                          />{" "}
                          {key}
                        </label>
                      ))}
                    </details>
                  )}
                  <button
                    className="btn btn-secondary"
                    disabled={addInstallation.isPending}
                  >
                    保存安装位置
                  </button>
                </form>
              </details>
              <form onSubmit={submit} className="member-add-form">
                <strong>
                  {editing
                    ? `${editing.agent.agentName} 的接入设置`
                    : nativeMode === "create"
                      ? "创建新的 CLI 成员"
                      : "接入已有 CLI 会话"}
                </strong>
                <Field label="接入方式">
                  <select
                    className="input"
                    value={accessMode}
                    onChange={(event) =>
                      setAccessMode(event.target.value as typeof accessMode)
                    }
                  >
                    <option value="managed_proxy">工具代理</option>
                    <option value="mcp_await">MCP 等待接入</option>
                    <option value="cli_await">CLI 等待接入</option>
                  </select>
                </Field>
                {!editing && (
                  <>
                    <Field label="成员角色" required>
                      <select
                        className="input"
                        value={memberRole}
                        onChange={(event) =>
                          setMemberRole(event.target.value as typeof memberRole)
                        }
                      >
                        <option value="worker">执行者</option>
                        <option value="knowledge_keeper">知识库维护者</option>
                      </select>
                    </Field>
                    <Field label="成员名称">
                      <input
                        className="input"
                        required
                        value={agentName}
                        onChange={(event) => setAgentName(event.target.value)}
                        placeholder="例如：前端开发"
                      />
                    </Field>
                    <Field label="成员职责">
                      <input
                        className="input"
                        required
                        value={roleDescription}
                        onChange={(event) =>
                          setRoleDescription(event.target.value)
                        }
                      />
                    </Field>
                  </>
                )}
                {accessMode === "managed_proxy" && (
                  <Field
                    label="会话处理方式"
                    hint="默认创建新的 CLI 会话；只有要继续历史时才需要提供已有会话编号。"
                  >
                    <select
                      className="input"
                      value={nativeMode}
                      onChange={(event) =>
                        setNativeMode(event.target.value as typeof nativeMode)
                      }
                    >
                      <option value="create">新建原生会话（推荐）</option>
                      <option
                        value="existing"
                        disabled={selectedInstallation?.toolId === "cursor"}
                      >
                        接入已有原生会话
                        {selectedInstallation?.toolId === "cursor"
                          ? "（暂不支持导入）"
                          : ""}
                      </option>
                    </select>
                  </Field>
                )}
                {accessMode === "managed_proxy" && (
                  <>
                    <Field label="工具安装">
                      <select
                        className="input"
                        required
                        value={installationId}
                        onChange={(event) =>
                          setInstallationId(event.target.value)
                        }
                      >
                        <option value="">请选择安装位置</option>
                        {installations.data?.map((item) => (
                          <option
                            key={item.id}
                            value={item.id}
                            disabled={
                              item.compatibility?.status === "unavailable"
                            }
                          >
                            {item.displayName} ·{" "}
                            {toolAvailability(
                              item.compatibility ??
                                toolCompatibility(item.toolId),
                              installationId === item.id ? endpoint : null,
                            ).status === "available"
                              ? "可用"
                              : "不可用"}{" "}
                            · {item.executablePath}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {selectedInstallation && (
                      <ToolCompatibilityNotice
                        toolId={selectedInstallation.toolId}
                        compatibility={selectedInstallation.compatibility}
                        installationId={selectedInstallation.id}
                        scope="session"
                        endpoint={endpoint}
                      />
                    )}
                    <Field label="项目目录">
                      <input
                        className="input"
                        required
                        value={workspacePath}
                        onChange={(event) =>
                          setWorkspacePath(event.target.value)
                        }
                      />
                    </Field>
                    {selectedInstallation && !selectedServerTool && (
                      <Field label="工具配置与会话数据目录" required>
                        <input
                          className="input"
                          value={runtimeNamespace}
                          onChange={(event) =>
                            setRuntimeNamespace(event.target.value)
                          }
                        />
                      </Field>
                    )}
                    {nativeMode === "existing" ? (
                      <Field label="已有会话编号">
                        <input
                          className="input"
                          required
                          value={nativeSessionId}
                          onChange={(event) =>
                            setNativeSessionId(event.target.value)
                          }
                        />
                      </Field>
                    ) : (
                      <p className="managed-setup-hint">
                        第一次派发任务时，工具会创建会话并自动保存编号。
                      </p>
                    )}
                    {selectedServerTool && (
                      <Field label="工具服务地址（MiMo / OpenCode）" required>
                        <input
                          className="input"
                          type="url"
                          required
                          value={endpoint}
                          onChange={(event) => setEndpoint(event.target.value)}
                          placeholder="http://127.0.0.1:端口"
                        />
                      </Field>
                    )}
                    {installations.data?.find(
                      (item) => item.id === installationId,
                    )?.toolId === "zcode" && (
                      <Field label="ZCode 执行权限">
                        <select
                          className="input"
                          value={zcodeMode}
                          onChange={(event) =>
                            setZcodeMode(event.target.value as typeof zcodeMode)
                          }
                        >
                          <option value="build">
                            常规审批（可能等待批准）
                          </option>
                          <option value="plan">分析模式</option>
                          <option value="edit">允许工作区编辑</option>
                          <option value="guarded">危险命令需批准</option>
                          <option value="yolo">自动批准工具操作</option>
                        </select>
                      </Field>
                    )}
                  </>
                )}
                {editing && (
                  <Field label="调整说明">
                    <input
                      className="input"
                      required
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                )}
                <p
                  style={{
                    color: "var(--c-text-secondary)",
                    fontSize: "var(--fs-sm)",
                  }}
                >
                  {accessMode === "managed_proxy"
                    ? nativeMode === "create"
                      ? "首次派发任务时会创建新的 CLI 会话并保存编号；后续任务继续该会话。"
                      : "将继续所选 CLI 会话的历史。请先停止其他窗口向这个会话发送任务；验证通过后才能代理执行。"
                    : "登记后，请让编程工具按原有方式接入此协作会话并等待任务。"}
                </p>
                <button
                  className="btn btn-primary"
                  disabled={addMember.isPending}
                >
                  {editing ? "保存调整" : "添加成员"}
                </button>
                {editing && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setEditing(null);
                      setAccessMode("managed_proxy");
                      setAgentName("");
                    }}
                  >
                    取消调整
                  </button>
                )}
              </form>
            </div>
          )}
          {activeTab === "deliveries" && (
            <div className="delivery-list" role="tabpanel">
              <div className="section-heading">
                <div>
                  <h2>最近投递记录</h2>
                  <p>查看任务如何送到原生会话，以及执行和回报的状态。</p>
                </div>
                <Badge>{deliveries.data?.length ?? 0} 条</Badge>
              </div>
              {!deliveries.data?.length && (
                <EmptyState
                  title="暂无投递记录"
                  desc="向代理成员发送任务后，可在这里查看执行进展。"
                />
              )}
              {deliveries.data?.map((delivery) => (
                <div
                  key={delivery.id}
                  style={{
                    padding: "var(--sp-2)",
                    borderBottom: "1px solid var(--c-border)",
                  }}
                >
                  <strong>{deliveryLabels[delivery.state]}</strong> ·{" "}
                  {routes.data?.find(
                    (member) => member.agent.id === delivery.targetAgentId,
                  )?.agent.agentName ?? delivery.targetAgentId}{" "}
                  · <code>{delivery.snapshot.binding.nativeSessionId}</code>
                  {delivery.state === "queued" && (
                    <small>
                      {" "}
                      · 此会话队列第{" "}
                      {
                        (deliveries.data ?? []).filter(
                          (item) =>
                            item.snapshot.nativeSessionKey ===
                              delivery.snapshot.nativeSessionKey &&
                            item.state === "queued" &&
                            item.sequence <= delivery.sequence,
                        ).length
                      }{" "}
                      项
                    </small>
                  )}
                  <small style={{ display: "block" }}>{delivery.id}</small>
                  {delivery.error && <p>{delivery.error}</p>}
                  {[
                    "queued",
                    "blocked",
                    "delivering",
                    "awaiting_result",
                  ].includes(delivery.state) && (
                    <button
                      className="btn btn-secondary"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(delivery.id)}
                    >
                      取消投递
                    </button>
                  )}
                  {delivery.state === "unknown" && (
                    <p>
                      请先核对工具历史和文件改动，确认执行已停止，再通过投递核对命令记录处理结果。
                    </p>
                  )}
                  <DeliveryDetails
                    delivery={delivery}
                    onChanged={() => {
                      void qc.invalidateQueries({
                        queryKey: ["deliveries", sessionId],
                      });
                      invalidateSession(qc, sessionId);
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
