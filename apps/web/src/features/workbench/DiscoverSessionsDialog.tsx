import { Dialog, Field } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function DiscoverSessionsDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [project, setProject] = useState("");
  const scan = useMutation({
    mutationFn: (projectPath?: string) =>
      getApiClient().discoverSessions(projectPath ? { projectPath } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  useEffect(() => {
    if (open) {
      setProject("");
      scan.mutate(undefined);
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="打开已有协作" width={820}>
      <div style={{ display: "grid", gap: 16 }}>
        <p style={{ margin: 0, color: "var(--c-text-secondary)" }}>
          查找当前协作服务中的会话，包含在项目中通过 MCP、CLI 或 IDE
          创建的会话。打开后继续使用原 Host、成员和消息。
        </p>
        <Field
          label="筛选项目目录"
          hint="留空扫描所有项目；指定目录后仅显示该项目的会话。"
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              aria-label="扫描项目目录"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="可选：完整的本地项目路径"
            />
            {window.loopmarshalDesktop?.selectProjectDirectory && (
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  const path =
                    await window.loopmarshalDesktop!.selectProjectDirectory!();
                  if (path) setProject(path);
                }}
              >
                浏览
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={scan.isPending}
              onClick={() => scan.mutate(project.trim() || undefined)}
            >
              {scan.isPending ? "扫描中…" : "开始扫描"}
            </button>
          </div>
        </Field>
        {scan.error && (
          <p role="alert" style={{ color: "var(--c-error)", margin: 0 }}>
            {scan.error.message}
          </p>
        )}
        {scan.isSuccess && (
          <>
            <div role="status">
              {scan.data.projectPath
                ? `项目：${scan.data.projectPath} · `
                : "所有项目 · "}
              找到 {scan.data.sessions.length} 个会话
            </div>
            {scan.data.projectPath && scan.data.unassignedSessionCount > 0 && (
              <small>
                另有 {scan.data.unassignedSessionCount}{" "}
                个旧会话未登记项目。清空目录可查看，原 Host
                再次接入时可补充项目。
              </small>
            )}
            <div style={{ display: "grid", gap: 12 }}>
              {scan.data.sessions.map((session) => (
                <section
                  key={session.id}
                  className="card"
                  aria-label={`扫描会话 ${session.name}`}
                  style={{
                    padding: 16,
                    display: "flex",
                    gap: 16,
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    <strong>{session.name}</strong>
                    <div>
                      Host：{session.host.displayName} ·{" "}
                      {session.host.accessMode === "core_runtime"
                        ? "本地 Agent"
                        : session.host.accessMode === "managed_proxy"
                          ? "CLI 代理"
                          : "外部 IDE / MCP / CLI"}
                    </div>
                    <small>
                      {session.projectPath ?? "未登记项目目录"} ·{" "}
                      {session.memberCount} 名成员
                    </small>
                  </div>
                  <button
                    className="btn btn-secondary"
                    aria-label={`打开会话 ${session.name}`}
                    onClick={() => {
                      onSelect(session.id);
                      onClose();
                    }}
                  >
                    打开会话
                  </button>
                </section>
              ))}
              {scan.data.sessions.length === 0 && (
                <p>
                  未找到会话。请确认外部工具连接的是当前协作服务，或清空项目目录重新扫描。
                </p>
              )}
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </Dialog>
  );
}
