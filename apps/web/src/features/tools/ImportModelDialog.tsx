import { Dialog, Field, pushToast } from "@/components/ui";
import { api, getApiClient } from "@/lib/api-client";
import { toolNames, type ProxyToolId } from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function ImportModelDialog({
  profileId,
  toolId,
  initialModelId = "",
  close,
}: {
  profileId: string;
  toolId: ProxyToolId;
  initialModelId?: string;
  close: () => void;
}) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [modelId, setModelId] = useState(initialModelId);
  const [responses, setResponses] = useState(false);
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api.models.list(),
  });
  const preview = useMutation({
    mutationFn: async () => {
      const { documents } = await client.getToolConfigDocuments(profileId);
      const user = documents.find((d) => d.id === "user");
      if (!user || (user.warning && !user.fields.length))
        throw new Error("工具配置暂不能安全读取，请先修复源配置。");
      return client.previewToolModel(profileId, {
        modelId,
        expectedFingerprint: user.fingerprint,
        responsesConfirmed: responses,
      });
    },
  });
  const save = useMutation({
    mutationFn: () =>
      client.applyToolConfig(profileId, preview.data!.previewId),
    onSuccess: () => {
      for (const key of [
        "tool-config-documents",
        "tool-config-backups",
        "tool-readiness",
      ])
        void qc.invalidateQueries({ queryKey: [key] });
      pushToast(
        "模型配置已写入，并已保存备份。新的工具执行将读取配置。",
        "success",
      );
      close();
    },
  });
  const compatible = models.data?.filter((m) =>
    toolId === "claude"
      ? m.provider === "anthropic"
      : toolId === "codex"
        ? m.provider !== "anthropic"
        : true,
  );
  const supported = ["codex", "claude", "qwen", "opencode", "mimo"].includes(
    toolId,
  );
  return (
    <Dialog
      open
      onClose={() => {
        if (!save.isPending) close();
      }}
      title={`为 ${toolNames[toolId]} 配置模型`}
      width={640}
    >
      <div className="tool-install-form">
        <p>
          使用“模型配置”中已有的连接。预览不显示密钥，确认后写入工具的用户配置，并自动备份原文件。
        </p>
        {!supported ? (
          <p role="status">
            此工具暂不支持导入当前模型协议。Gemini CLI 需要原生 Gemini
            认证；可在工具配置中选择官方登录或 API Key
            方式，沿用原工具的认证步骤。
          </p>
        ) : (
          <>
            <Field label="已有模型" required>
              <select
                className="input"
                value={modelId}
                disabled={save.isPending}
                onChange={(e) => {
                  setModelId(e.target.value);
                  preview.reset();
                  save.reset();
                }}
              >
                <option value="">请选择模型</option>
                {compatible?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.modelId}
                  </option>
                ))}
              </select>
            </Field>
            {compatible?.length === 0 && (
              <p>没有协议匹配的模型，请先在“模型配置”中添加。</p>
            )}
            {toolId === "claude" && (
              <p>仅显示使用 Anthropic Messages 协议的模型。</p>
            )}
            {toolId === "codex" && (
              <label className="discussion-choice">
                <input
                  type="checkbox"
                  checked={responses}
                  disabled={save.isPending}
                  onChange={(e) => {
                    setResponses(e.target.checked);
                    preview.reset();
                  }}
                />
                我确认这个服务及模型支持 Responses API（仅兼容 Chat Completions
                不足以使用 Codex）
              </label>
            )}
            <button
              className="btn btn-secondary"
              disabled={
                !modelId ||
                (toolId === "codex" && !responses) ||
                preview.isPending ||
                save.isPending
              }
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? "正在准备…" : "预览写入内容"}
            </button>
            {preview.data && (
              <div className="tool-install-preview">
                <strong>写入文件</strong>
                <code>{preview.data.path}</code>
                <ul>
                  {preview.data.changes.map((change, i) => (
                    <li key={i}>
                      {change.fieldId}：{String(change.after ?? "恢复默认")}
                    </li>
                  ))}
                </ul>
                <p>{preview.data.effectiveAfter}</p>
                <button
                  className="btn btn-primary"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? "正在写入…" : "确认写入"}
                </button>
              </div>
            )}
          </>
        )}
        {(models.error ?? preview.error ?? save.error) && (
          <p role="alert">
            {(models.error ?? preview.error ?? save.error)?.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
