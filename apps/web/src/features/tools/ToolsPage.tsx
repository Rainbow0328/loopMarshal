import { Icon } from "@/components/Icon";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  pushToast,
} from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import {
  proxyToolIds,
  toolEnvironmentKeys,
  toolNames,
  type ProxyToolId,
  type ToolDiscoveryCandidate,
  type ToolInstallation,
} from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ToolCompatibilityNotice } from "./ToolCompatibilityNotice";

const names = toolNames;

export function ToolsPage() {
  const api = getApiClient();
  const qc = useQueryClient();
  const [showInstall, setShowInstall] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tool, setTool] = useState<ProxyToolId>("codex");
  const [path, setPath] = useState("");
  const installations = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => api.listToolInstallations(),
  });
  const scan = useMutation({
    mutationFn: () => api.discoverTools(),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["tool-installations"] });
      pushToast(`已发现 ${result.candidates.length} 个本机工具`, "success");
    },
  });
  const add = useMutation({
    mutationFn: (candidate?: ToolDiscoveryCandidate) =>
      api.createToolInstallation({
        toolId: candidate?.toolId ?? tool,
        displayName: names[candidate?.toolId ?? tool],
        executablePath: candidate?.executablePath ?? path,
      }),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["tool-installations"] });
      setShowInstall(false);
      setPath("");
      pushToast(`${result.displayName} 已加入工具列表`, "success");
    },
  });
  const error = installations.error ?? scan.error ?? add.error;

  return (
    <>
      <PageHeader
        title="发现 Worker"
        subtitle="查找本机 Worker，管理接入与配置"
        actions={
          <>
            <Link
              className="btn btn-secondary"
              to="/tool-config"
              search={{ installationId: undefined }}
            >
              <Icon name="settings" size={16} />
              编辑工具配置
            </Link>
            <button
              className="btn btn-secondary"
              onClick={() => setShowInstall(true)}
            >
              <Icon name="plus" size={16} />
              添加工具
            </button>
            <button
              className="btn btn-primary"
              disabled={scan.isPending}
              onClick={() => scan.mutate()}
            >
              <Icon name="search" size={16} />
              {scan.isPending ? "正在查找…" : "发现 Worker"}
            </button>
          </>
        }
      />
      <PageContainer>
        {error && (
          <ErrorState
            message={error.message}
            onRetry={() => void installations.refetch()}
          />
        )}
        {scan.data && (
          <section
            className="scan-results card connection-scan-results"
            aria-label="发现的 Worker"
          >
            <div className="section-heading">
              <div>
                <h2>发现的 Worker</h2>
                <p>添加后即可配置模型与密钥。</p>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                aria-label="收起扫描结果"
                onClick={() => scan.reset()}
              >
                <Icon name="close" size={17} />
              </button>
            </div>
            {!scan.data.candidates.length && (
              <EmptyState
                title="没有发现新的 Worker"
                desc="可以手动登记工具的可执行文件路径。"
              />
            )}
            {scan.data.candidates.map((candidate) => (
              <div
                className="scan-result-row"
                key={candidate.toolId + candidate.executablePath}
              >
                <span className={`tool-monogram tool-${candidate.toolId}`}>
                  {names[candidate.toolId].slice(0, 1)}
                </span>
                <div>
                  <strong>{names[candidate.toolId]}</strong>
                  <code>{candidate.executablePath}</code>
                  <ToolCompatibilityNotice
                    toolId={candidate.toolId}
                    compatibility={candidate.compatibility}
                    installationId={
                      candidate.registeredInstallationId ?? undefined
                    }
                  />
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={
                    add.isPending || Boolean(candidate.registeredInstallationId)
                  }
                  onClick={() => add.mutate(candidate)}
                >
                  {candidate.registeredInstallationId ? "已添加" : "添加工具"}
                </button>
              </div>
            ))}
          </section>
        )}
        <div className="installation-list-heading">
          <strong>{installations.data?.length ?? 0} 个 Worker</strong>
          <span>选择 Worker 配置模型与密钥。</span>
        </div>
        {installations.isLoading ? (
          <Loading text="正在读取本机连接…" />
        ) : installations.data?.length ? (
          <div className="installation-catalog">
            {installations.data.map((installation) => (
              <article className="installation-card" key={installation.id}>
                <div className="installation-card-main">
                  <span className={`tool-monogram tool-${installation.toolId}`}>
                    {names[installation.toolId].slice(0, 1)}
                  </span>
                  <div className="installation-card-copy">
                    <div className="installation-title-row">
                      <h3>{installation.displayName}</h3>
                      {installation.displayName !==
                        names[installation.toolId] && (
                        <Badge variant="neutral">
                          {names[installation.toolId]}
                        </Badge>
                      )}
                    </div>
                    <code title={installation.executablePath}>
                      {installation.executablePath}
                    </code>
                    <ToolCompatibilityNotice
                      toolId={installation.toolId}
                      compatibility={installation.compatibility}
                      installationId={installation.id}
                      compact
                    />
                  </div>
                </div>
                <div className="installation-card-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/tool-config"
                    search={{ installationId: installation.id }}
                  >
                    模型与密钥
                    <Icon name="arrow" size={14} />
                  </Link>
                  <button
                    className="btn btn-ghost btn-icon"
                    aria-label={`编辑 ${installation.displayName} 安装设置`}
                    title="安装设置"
                    onClick={() => setEditingId(installation.id)}
                  >
                    <Icon name="settings" size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有可用的 Worker"
            desc="扫描本机已安装的 Worker，或手动登记一个工具位置。"
            action={
              <button
                className="btn btn-primary"
                onClick={() => scan.mutate()}
                disabled={scan.isPending}
              >
                <Icon name="search" size={16} />
                发现 Worker
              </button>
            }
          />
        )}
      </PageContainer>
      <Dialog
        open={showInstall}
        onClose={() => setShowInstall(false)}
        title="添加本机工具"
        width={560}
      >
        <p className="muted-copy">
          登记可供会话使用的 Worker。模型、服务地址和 API
          密钥在独立的工具配置页面维护。
        </p>
        <form
          className="config-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(undefined);
          }}
        >
          <Field label="Worker" required>
            <select
              className="input"
              value={tool}
              onChange={(event) => setTool(event.target.value as ProxyToolId)}
            >
              {proxyToolIds.map((id) => (
                <option key={id} value={id}>
                  {names[id]}
                </option>
              ))}
            </select>
          </Field>
          <ToolCompatibilityNotice toolId={tool} />
          <Field
            label="可执行文件完整路径"
            required
            hint="填写本机实际运行的 CLI 文件或启动脚本。"
          >
            <input
              className="input"
              required
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="例如 C:\Tools\codex.exe"
            />
          </Field>
          {add.error && <ErrorState message={add.error.message} />}
          <div className="config-form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowInstall(false)}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={add.isPending || !path.trim()}
            >
              {add.isPending ? "正在添加…" : "添加工具"}
            </button>
          </div>
        </form>
      </Dialog>
      <InstallationEditorDialog
        key={editingId ?? "closed"}
        installation={
          installations.data?.find((item) => item.id === editingId) ?? null
        }
        onClose={() => setEditingId(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ["tool-installations"] });
          void qc.invalidateQueries({ queryKey: ["tool-readiness"] });
          setEditingId(null);
        }}
      />
    </>
  );
}

function InstallationEditorDialog({
  installation,
  onClose,
  onSaved,
}: {
  installation: ToolInstallation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = getApiClient();
  const [displayName, setDisplayName] = useState(
    installation?.displayName ?? "",
  );
  const [executablePath, setExecutablePath] = useState(
    installation?.executablePath ?? "",
  );
  const [executableArgs, setExecutableArgs] = useState(
    installation?.executableArgs.join("\n") ?? "",
  );
  const [environmentKeys, setEnvironmentKeys] = useState<string[]>(
    installation?.environmentKeys ?? [],
  );
  const [version, setVersion] = useState(installation?.version ?? "");
  const update = useMutation({
    mutationFn: () => {
      if (!installation) throw new Error("请选择一个工具连接。");
      return api.updateToolInstallation(installation.id, {
        displayName: displayName.trim(),
        executablePath: executablePath.trim(),
        executableArgs: executableArgs
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
        environmentKeys,
        version: version.trim() || null,
      });
    },
    onSuccess: () => {
      pushToast("安装设置已更新", "success");
      onSaved();
    },
  });
  return (
    <Dialog
      open={Boolean(installation)}
      onClose={onClose}
      title="安装设置"
      width={620}
    >
      {installation && (
        <form
          className="config-create-form installation-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate();
          }}
        >
          <div className="installation-editor-heading">
            <span className={`tool-monogram tool-${installation.toolId}`}>
              {names[installation.toolId].slice(0, 1)}
            </span>
            <div>
              <strong>{names[installation.toolId]}</strong>
              <p>
                维护 CLI
                的启动位置与运行时选项。模型和认证信息请前往工具配置页面。
              </p>
            </div>
          </div>
          <Field
            label="连接名称"
            required
            hint="用于在会话成员选择器中识别这套 CLI。"
          >
            <input
              className="input"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field
            label="可执行文件完整路径"
            required
            hint="路径必须指向当前设备上真实存在的文件。"
          >
            <input
              className="input"
              required
              value={executablePath}
              onChange={(event) => setExecutablePath(event.target.value)}
            />
          </Field>
          <Field
            label="启动参数"
            hint="每行一个参数；会话选择参数由 LoopMarshal 自动处理。"
          >
            <textarea
              className="input"
              rows={3}
              value={executableArgs}
              onChange={(event) => setExecutableArgs(event.target.value)}
              placeholder="例如 --verbose"
            />
          </Field>
          <Field
            label="允许继承的环境变量"
            hint="仅传递本机已有的变量值；此处只保存名称，不保存密钥内容。"
          >
            <div className="environment-key-grid">
              {toolEnvironmentKeys[installation.toolId].length ? (
                toolEnvironmentKeys[installation.toolId].map((key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={environmentKeys.includes(key)}
                      onChange={(event) =>
                        setEnvironmentKeys((current) =>
                          event.target.checked
                            ? [...current, key]
                            : current.filter((value) => value !== key),
                        )
                      }
                    />
                    <code>{key}</code>
                  </label>
                ))
              ) : (
                <p className="muted-copy">
                  该工具不支持从 Core 环境继承模型凭据。
                </p>
              )}
            </div>
          </Field>
          <Field
            label="版本标记"
            hint="可选，用于确认本机实际使用的 CLI 版本。"
          >
            <input
              className="input"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="例如 1.2.3"
            />
          </Field>
          {update.error && <ErrorState message={update.error.message} />}
          <div className="config-form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={
                update.isPending ||
                !displayName.trim() ||
                !executablePath.trim()
              }
            >
              <Icon name="check" size={15} />
              {update.isPending ? "正在保存…" : "保存安装设置"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
