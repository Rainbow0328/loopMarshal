import { Dialog, Field } from "@/components/ui";
import { api, getApiClient } from "@/lib/api-client";
import { toolNames, type ProxyToolId } from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ImportModelDialog } from "./ImportModelDialog";
import "./tool-install.css";

export function InstallToolsDialog({ close }: { close: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [tool, setTool] = useState<ProxyToolId>("codex");
  const [root, setRoot] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const promptedJob = useRef<string | null>(null);
  const settings = useQuery({
    queryKey: ["tool-installer"],
    queryFn: () => client.getToolInstaller(),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === "installing")
        ? 1500
        : false,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api.models.list(),
  });
  const spec = settings.data?.catalog.find((entry) => entry.toolId === tool);
  const job = settings.data?.jobs.find((j) => j.id === jobId);
  const path = root ?? settings.data?.root ?? "";
  const installing = Boolean(
    settings.data?.jobs.some((j) => j.status === "installing"),
  );
  const install = useMutation({
    mutationFn: () => client.startToolInstall({ toolId: tool, root: path }),
    onSuccess: (value) => {
      setJobId(value.id);
      void settings.refetch();
    },
  });
  const saveRoot = useMutation({
    mutationFn: () => client.saveToolInstallRoot(path),
    onSuccess: () => {
      void settings.refetch();
    },
  });
  useEffect(() => {
    if (job?.status === "installed") {
      void qc.invalidateQueries({ queryKey: ["tool-installations"] });
      void qc.invalidateQueries({ queryKey: ["tool-config-profiles"] });
    }
  }, [job?.status, qc]);
  useEffect(() => {
    if (
      job?.status === "installed" &&
      modelId &&
      promptedJob.current !== job.id
    ) {
      promptedJob.current = job.id;
      setImporting(true);
    }
  }, [job?.status, job?.id, modelId]);
  const compatible = models.data?.filter(
    (m) =>
      spec?.modelProtocols.length &&
      (tool === "claude"
        ? m.provider === "anthropic"
        : tool === "codex"
          ? m.provider !== "anthropic"
          : true),
  );
  return (
    <>
      <Dialog open onClose={close} title="安装 Worker" width={700}>
        <div className="tool-install-form">
          <p>
            从官方 npm
            包安装到指定目录，不覆盖已有工具，也不修改系统的全局安装。安装本身免费，模型调用仍按服务商收费。
          </p>
          <Field label="选择工具" required>
            <select
              className="input"
              value={tool}
              disabled={installing}
              onChange={(e) => {
                setTool(e.target.value as ProxyToolId);
                setModelId("");
                setJobId(null);
                install.reset();
              }}
            >
              {settings.data?.catalog.map((entry) => (
                <option key={entry.toolId} value={entry.toolId}>
                  {toolNames[entry.toolId]}
                  {entry.packageName ? "" : "（请使用官方安装）"}
                </option>
              ))}
            </select>
          </Field>
          {spec?.reason && <p role="status">{spec.reason}</p>}
          {spec?.packageName && (
            <p>
              安装来源：
              <a href={spec.source} target="_blank" rel="noreferrer">
                {spec.packageName}
              </a>
              。桌面版使用内置安装环境；源码运行需要 Node.js 22+ 和
              npm。第三方程序可能有额外系统要求。
            </p>
          )}
          {settings.data && !settings.data.npmAvailable && (
            <p role="alert">
              未找到 npm。源码运行请安装 Node.js 22
              或以上版本后重启；桌面版请检查客户端的运行环境是否完整。
            </p>
          )}
          <Field label="工具存储目录" required>
            <div className="tool-install-directory">
              <input
                className="input"
                value={path}
                onChange={(e) => setRoot(e.target.value)}
                disabled={installing}
                placeholder="例如 F:\softwarecache\LoopMarshalTools"
              />
              {window.loopmarshalDesktop && (
                <button
                  className="btn btn-secondary"
                  disabled={installing}
                  onClick={() => {
                    void window
                      .loopmarshalDesktop!.selectProjectDirectory()
                      .then((directory) => {
                        if (directory) setRoot(directory);
                      });
                  }}
                >
                  浏览
                </button>
              )}
            </div>
          </Field>
          <div className="tool-install-paths">
            <span>程序：tools/{tool}</span>
            <span>
              配置和历史：config/{tool}
              {tool === "gemini"
                ? "/.gemini"
                : tool === "mimo"
                  ? "/config"
                  : ""}
            </span>
            <span>受管缓存：cache/{tool}</span>
          </div>
          <p>
            以上目录均位于所选存储目录内。工具通过 LoopMarshal
            启动时使用这些路径；从系统终端直接启动的旧工具不受影响。部分第三方临时文件仍遵循系统设置。
          </p>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!path || installing || saveRoot.isPending}
            onClick={() => saveRoot.mutate()}
          >
            {saveRoot.isSuccess ? "已记住默认目录" : "设为默认目录"}
          </button>
          <Field label="安装后使用的模型（选填）">
            <select
              className="input"
              value={modelId}
              disabled={installing || !spec?.modelProtocols.length}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">安装后再设置，或沿用官方登录</option>
              {compatible?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.modelId}
                </option>
              ))}
            </select>
          </Field>
          {tool === "gemini" && (
            <p>
              Gemini CLI 使用原生 Gemini 认证，无法直接导入当前的
              OpenAI/Anthropic 模型连接。安装后可选择官方登录或配置 Gemini API
              Key。
            </p>
          )}
          {(settings.error ??
            models.error ??
            install.error ??
            saveRoot.error) && (
            <p role="alert">
              {
                (
                  settings.error ??
                  models.error ??
                  install.error ??
                  saveRoot.error
                )?.message
              }
            </p>
          )}
          {job?.status === "failed" && <p role="alert">{job.error}</p>}
          {job?.status === "installed" ? (
            <div className="tool-install-success">
              <strong>{toolNames[job.toolId]} 已安装并加入 Worker 列表</strong>
              <p>接下来配置模型或完成官方登录，再到新建协作中选择该工具。</p>
              {job.profileId && (
                <button
                  className="btn btn-primary"
                  onClick={() => setImporting(true)}
                >
                  配置模型{modelId ? "并预览写入" : ""}
                </button>
              )}
              <Link
                className="btn btn-secondary"
                to="/tool-config"
                search={{ installationId: job.installationId ?? undefined }}
                onClick={close}
              >
                打开工具配置
              </Link>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              disabled={
                !path ||
                !spec?.packageName ||
                !settings.data?.npmAvailable ||
                installing ||
                install.isPending
              }
              onClick={() => install.mutate()}
            >
              {installing || install.isPending
                ? "正在下载安装…可关闭此窗口"
                : "下载安装"}
            </button>
          )}
          {!!settings.data?.jobs.length && (
            <details>
              <summary>安装记录</summary>
              <ul>
                {settings.data.jobs.map((item) => (
                  <li key={item.id}>
                    {toolNames[item.toolId]} ·{" "}
                    {item.status === "installed"
                      ? "已安装"
                      : item.status === "installing"
                        ? "安装中"
                        : "未完成"}
                    {item.error && <p>{item.error}</p>}
                    {item.status === "installed" && item.profileId && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setJobId(item.id);
                          setTool(item.toolId);
                          setModelId("");
                          setImporting(true);
                        }}
                      >
                        配置模型
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Dialog>
      {importing && job?.profileId && (
        <ImportModelDialog
          profileId={job.profileId}
          toolId={job.toolId}
          initialModelId={modelId}
          close={() => setImporting(false)}
        />
      )}
    </>
  );
}
