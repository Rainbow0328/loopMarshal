import { Dialog, Field, pushToast } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { WebAgentRuntime } from "@loopmarshal/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  useUpdateRuntimeMutation,
  useWorkflowsQuery,
} from "./workbench-queries";

export function RuntimeSettingsDialog({
  open,
  onClose,
  runtime,
  models,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  runtime: WebAgentRuntime | null;
  models: Array<{ id: string; name: string; modelId: string }>;
  sessionId: string;
}) {
  const [externalMcpServerIds, setExternalMcpServerIds] = useState<string[]>(
    [],
  );
  const mcpQuery = useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: () => api.mcpServers.list(),
    enabled: open,
  });
  const [customDuty, setCustomDuty] = useState("");
  const [customSkillIds, setCustomSkillIds] = useState<string[]>([]);
  const [modelConfigId, setModelConfigId] = useState("");
  const [skillIdInput, setSkillIdInput] = useState("");
  const workflowsQuery = useWorkflowsQuery(open);
  const updateRuntime = useUpdateRuntimeMutation(sessionId);

  useEffect(() => {
    if (open && runtime) {
      setExternalMcpServerIds(runtime.externalMcpServerIds ?? []);
      setCustomDuty(runtime.customDuty ?? "");
      setCustomSkillIds(runtime.customSkillIds ?? []);
      setModelConfigId(runtime.modelConfigId ?? "");
      setSkillIdInput("");
    }
  }, [open, runtime]);

  if (!runtime) return null;

  const workflows = workflowsQuery.data ?? [];
  const availableSkills = workflows.filter(
    (w) => w.enabled && w.role === runtime.role,
  );

  const handleAddSkill = () => {
    const id = skillIdInput.trim();
    if (id && !customSkillIds.includes(id)) {
      setCustomSkillIds([...customSkillIds, id]);
      setSkillIdInput("");
    }
  };

  const handleRemoveSkill = (id: string) => {
    setCustomSkillIds(customSkillIds.filter((s) => s !== id));
  };

  const handleSave = () => {
    updateRuntime.mutate(
      {
        runtimeId: runtime.id,
        customDuty: customDuty.trim() || null,
        customSkillIds,
        externalMcpServerIds,
        modelConfigId: modelConfigId || undefined,
      },
      {
        onSuccess: () => {
          pushToast("运行时设置已保存", "success");
          onClose();
        },
        onError: (e) => pushToast(e.message, "error"),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title="运行时设置" width={520}>
      <div
        style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}
      >
        {/* Model config */}
        <Field label="模型配置" hint="选择该运行时使用的模型配置">
          <select
            className="input"
            value={modelConfigId}
            onChange={(e) => setModelConfigId(e.target.value)}
          >
            <option value="">使用默认模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.modelId})
              </option>
            ))}
          </select>
        </Field>

        <fieldset
          style={{ border: "1px solid var(--c-border)", borderRadius: 8 }}
        >
          <legend>MCP 工具</legend>
          <small>
            项目读取与会话协作工具默认启用。修改后在下一次执行时生效。
          </small>
          {mcpQuery.data
            ?.filter(
              (server) =>
                server.enabled || externalMcpServerIds.includes(server.id),
            )
            .map((server) => (
              <label key={server.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={externalMcpServerIds.includes(server.id)}
                  onChange={(e) =>
                    setExternalMcpServerIds(
                      e.target.checked
                        ? [...externalMcpServerIds, server.id]
                        : externalMcpServerIds.filter((id) => id !== server.id),
                    )
                  }
                />{" "}
                {server.name}
                {!server.enabled && "（已停用）"}
              </label>
            ))}
        </fieldset>
        {/* Custom Duty */}
        <Field
          label="自定义职责"
          hint="注入到 system prompt 的额外职责描述（可选）"
        >
          <textarea
            className="input"
            style={{ minHeight: 80, resize: "vertical" }}
            value={customDuty}
            onChange={(e) => setCustomDuty(e.target.value)}
            placeholder="例如：负责前端 React 组件开发，关注可访问性和性能"
          />
        </Field>

        {/* Custom Skills */}
        <div>
          <div
            style={{
              fontSize: "var(--fs-sm)",
              fontWeight: 500,
              color: "var(--c-text-secondary)",
              marginBottom: "var(--sp-1)",
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-1)",
            }}
          >
            自定义 Skill
            <span
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--c-text-tertiary)",
              }}
            >
              （注入到 system prompt 的额外指令）
            </span>
          </div>

          {/* Available skills from workflow definitions */}
          {availableSkills.length > 0 && (
            <div
              style={{
                marginBottom: "var(--sp-2)",
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--sp-1)",
              }}
            >
              {availableSkills.map((w) => {
                const isSelected = customSkillIds.includes(w.id);
                return (
                  <button
                    key={w.id}
                    className={`btn btn-sm ${isSelected ? "btn-primary" : "btn-secondary"}`}
                    onClick={() =>
                      isSelected
                        ? handleRemoveSkill(w.id)
                        : setCustomSkillIds([...customSkillIds, w.id])
                    }
                  >
                    {isSelected ? "✓ " : "+ "}
                    {w.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Manual skill ID input */}
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <input
              className="input"
              value={skillIdInput}
              onChange={(e) => setSkillIdInput(e.target.value)}
              placeholder="输入 Skill ID 手动添加…"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddSkill();
                }
              }}
            />
            <button
              className="btn btn-secondary"
              onClick={handleAddSkill}
              disabled={!skillIdInput.trim()}
            >
              添加
            </button>
          </div>

          {/* Selected skill list */}
          {customSkillIds.length > 0 && (
            <div
              style={{
                marginTop: "var(--sp-2)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--sp-1)",
              }}
            >
              {customSkillIds.map((id) => {
                const wf = workflows.find((w) => w.id === id);
                return (
                  <div
                    key={id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "var(--sp-2) var(--sp-3)",
                      borderRadius: "var(--r-sm)",
                      background: "var(--c-bg-subtle)",
                      border: "1px solid var(--c-border-subtle)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: "var(--fs-sm)",
                          fontWeight: 600,
                          color: "var(--c-text-primary)",
                        }}
                      >
                        {wf?.name ?? id}
                      </span>
                      {wf?.description && (
                        <span
                          style={{
                            fontSize: "var(--fs-xs)",
                            color: "var(--c-text-tertiary)",
                            marginLeft: "var(--sp-2)",
                          }}
                        >
                          {wf.description}
                        </span>
                      )}
                    </div>
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => handleRemoveSkill(id)}
                      title="移除 Skill"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Error message */}
        {updateRuntime.error && (
          <div
            style={{
              padding: "var(--sp-2) var(--sp-3)",
              borderRadius: "var(--r-sm)",
              background: "var(--c-error-subtle)",
              border: "1px solid var(--c-error-subtle)",
              fontSize: "var(--fs-sm)",
              color: "var(--c-error)",
              lineHeight: 1.5,
            }}
          >
            {updateRuntime.error.message}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--sp-2)",
            marginTop: "var(--sp-2)",
          }}
        >
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={updateRuntime.isPending}
            onClick={handleSave}
          >
            {updateRuntime.isPending ? "保存中…" : "保存设置"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
