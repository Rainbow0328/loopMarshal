import { Icon } from "@/components/Icon";
import { Badge, ConfirmDialog, pushToast, RoleBadge } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import type { ConsoleMember, WebAgentRuntime } from "@loopmarshal/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { openActivityWindow } from "./activity-window";
import { memberState } from "./member-state";
import { RuntimeControls } from "./RuntimeControls";
import { RuntimeSettingsDialog } from "./RuntimeSettingsDialog";
import {
  getRuntimeForAgent,
  useAddKnowledgeKeeperMutation,
  useDeleteRuntimeMutation,
  useRuntimeCommandMutation,
} from "./workbench-queries";

export function MembersPanel({
  members,
  runtimes,
  models,
  sessionId,
  onMessages,
}: {
  members: ConsoleMember[];
  runtimes: WebAgentRuntime[];
  models: Array<{ id: string; name: string; modelId: string }>;
  sessionId: string;
  onMessages: (id: string) => void;
}) {
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const command = useRuntimeCommandMutation(sessionId);
  const remove = useDeleteRuntimeMutation(sessionId);
  const addKeeper = useAddKnowledgeKeeperMutation(sessionId);
  const installations = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => getApiClient().listToolInstallations(),
  });
  return (
    <>
      <p className="muted-copy member-directory-intro">
        Host 负责统筹，Worker 执行任务，知识库维护者整理项目知识。
      </p>
      <div className="member-directory">
        {members.map((member) => {
          const runtime = getRuntimeForAgent(runtimes, member.agentId);
          const state = memberState(member, runtime);
          const installation = installations.data?.find(
            (item) => item.id === member.route?.binding?.installationId,
          );
          const tool = runtime
            ? (models.find((item) => item.id === runtime.modelConfigId)?.name ??
              "本地模型 Agent")
            : (installation?.displayName ??
              (member.route?.accessMode === "managed_proxy"
                ? "编程工具"
                : "外部 IDE / 编程工具"));
          return (
            <article key={member.agentId} className="member-directory-row">
              <span className={`agent-avatar avatar-${member.role}`}>
                <Icon
                  name={
                    member.role === "host"
                      ? "workspace"
                      : member.role === "knowledge_keeper"
                        ? "book"
                        : "terminal"
                  }
                  size={19}
                />
              </span>
              <div className="member-directory-copy">
                <div className="member-directory-title">
                  <strong>{member.displayName}</strong>
                  <RoleBadge role={member.role} />
                  <Badge variant={state.variant}>{state.label}</Badge>
                </div>
                <p>{member.duty || "未填写职责"}</p>
                <small>
                  {tool} /{" "}
                  {runtime
                    ? "本地运行"
                    : member.route?.accessMode === "managed_proxy"
                      ? "由 LoopMarshal 调用"
                      : "通过 MCP 或命令接入"}
                </small>
                {(member.route?.lastError || member.activity?.lastFailure) && (
                  <p className="member-error">
                    {member.route?.lastError ?? member.activity?.lastFailure}
                  </p>
                )}
                <div className="member-directory-actions">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onMessages(member.agentId)}
                  >
                    查看消息
                  </button>
                  {member.route?.accessMode === "managed_proxy" &&
                    Boolean(member.activity?.running) && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          void openActivityWindow(sessionId, member.agentId)
                        }
                      >
                        <Icon name="external" size={14} />
                        查看运行
                      </button>
                    )}
                  {runtime && (
                    <>
                      <RuntimeControls
                        runtime={runtime}
                        compact
                        onCommand={(value) =>
                          command.mutate(
                            { runtimeId: runtime.id, command: value },
                            {
                              onError: (error) =>
                                pushToast(error.message, "error"),
                            },
                          )
                        }
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setSettingsId(runtime.id)}
                      >
                        运行设置
                      </button>
                      {member.role !== "host" && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDeleteId(runtime.id)}
                        >
                          移除运行时
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {!members.some((member) => member.role === "knowledge_keeper") && (
        <div className="member-add-keeper">
          <div>
            <strong>知识库维护者</strong>
            <p>可选；未添加时由 Host 维护知识库。</p>
          </div>
          <select
            className="input"
            aria-label="知识库维护者模型"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            <option value="">选择本地模型</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-secondary"
            disabled={!modelId || addKeeper.isPending}
            onClick={() =>
              addKeeper.mutate(
                { modelConfigId: modelId },
                { onError: (error) => pushToast(error.message, "error") },
              )
            }
          >
            添加维护者
          </button>
        </div>
      )}
      <RuntimeSettingsDialog
        open={settingsId !== null}
        onClose={() => setSettingsId(null)}
        runtime={runtimes.find((item) => item.id === settingsId) ?? null}
        models={models}
        sessionId={sessionId}
      />
      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="移除运行时"
        message="停止并移除这个本地运行时？已有消息记录会保留。"
        confirmText="移除"
        danger
        onConfirm={() => {
          if (deleteId)
            remove.mutate(deleteId, {
              onSuccess: () => {
                setDeleteId(null);
                pushToast("运行时已移除", "success");
              },
              onError: (error) => pushToast(error.message, "error"),
            });
        }}
      />
    </>
  );
}
