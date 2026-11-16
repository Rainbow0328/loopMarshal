import { Icon } from "@/components/Icon";
import { Badge, Loading, pushToast } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import {
  type ToolConfigDocument,
  type ToolConfigProfile,
} from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { DocumentEditor } from "./ToolConfigDocumentEditor";
import { ImportModelDialog } from "./ImportModelDialog";
import "./tool-install.css";

const documentName = (document: ToolConfigDocument) =>
  document.scope === "user"
    ? "用户配置"
    : document.id === "project-local"
      ? "项目本地配置"
      : "项目配置";

export function ProfileEditor({
  profile,
  onDirtyChange,
}: {
  profile: ToolConfigProfile;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = getApiClient();
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState("user");
  const [editorRevision, setEditorRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const documents = useQuery({
    queryKey: ["tool-config-documents", profile.id],
    queryFn: () => api.getToolConfigDocuments(profile.id),
    refetchOnWindowFocus: false,
  });
  const backups = useQuery({
    queryKey: ["tool-config-backups", profile.id],
    queryFn: () => api.getToolConfigBackups(profile.id),
  });
  const activeDocument =
    documents.data?.documents.find((item) => item.id === documentId) ??
    documents.data?.documents[0];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tool-readiness"] });
    setEditorRevision((value) => value + 1);
    void qc.invalidateQueries({
      queryKey: ["tool-config-documents", profile.id],
    });
    void qc.invalidateQueries({
      queryKey: ["tool-config-backups", profile.id],
    });
  };
  const setEdited = (value: boolean) => {
    setDirty(value);
    onDirtyChange?.(value);
  };
  const allowDiscard = () =>
    !dirty || window.confirm("当前修改尚未保存，确认放弃修改？");
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreToolConfig(profile.id, id),
    onSuccess: () => {
      setRestoring(null);
      setEdited(false);
      refresh();
      pushToast("工具配置已恢复", "success");
    },
  });
  return (
    <section className="config-panel native-config-panel">
      <div className="native-config-toolbar">
        <button
          className="btn btn-secondary btn-sm"
          disabled={dirty}
          title={
            dirty
              ? "请先保存或放弃当前修改"
              : "使用 LoopMarshal 中已有的模型连接"
          }
          onClick={() => setImporting(true)}
        >
          导入已有模型
        </button>
        <div className="native-config-sources" aria-label="配置文件">
          {documents.data?.documents.map((document) => (
            <button
              key={document.id}
              className={activeDocument?.id === document.id ? "is-active" : ""}
              onClick={() => {
                if (document.id === activeDocument?.id || !allowDiscard())
                  return;
                setEdited(false);
                setDocumentId(document.id);
              }}
            >
              {documentName(document)}
            </button>
          ))}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (allowDiscard()) {
              setEdited(false);
              refresh();
            }
          }}
        >
          <Icon name="refresh" size={14} />
          重新读取
        </button>
      </div>
      {(documents.error ?? backups.error ?? restore.error) && (
        <p role="alert" className="config-warning">
          {(documents.error ?? backups.error ?? restore.error)?.message}
        </p>
      )}
      {importing && (
        <ImportModelDialog
          profileId={profile.id}
          toolId={profile.toolId}
          close={() => {
            setImporting(false);
            refresh();
          }}
        />
      )}
      {documents.isLoading && <Loading text="读取工具配置…" />}
      {activeDocument && (
        <DocumentEditor
          key={activeDocument.id + activeDocument.fingerprint + editorRevision}
          profileId={profile.id}
          document={activeDocument}
          onDirtyChange={setEdited}
          onSaved={refresh}
        />
      )}
      <details className="backup-panel">
        <summary>备份与恢复（{backups.data?.backups.length ?? 0}）</summary>
        <p>每次保存前自动备份，保留最近 20 次。</p>
        {backups.data?.backups.map((backup) => (
          <div key={backup.id} className="config-backup-row">
            <span>
              {new Date(backup.createdAt).toLocaleString()} /{" "}
              {backup.documentId}
            </span>
            {backup.restoredAt ? (
              <Badge>已恢复</Badge>
            ) : (
              backup.canRestore && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    if (allowDiscard()) setRestoring(backup.id);
                  }}
                >
                  恢复
                </button>
              )
            )}
            {restoring === backup.id && (
              <div className="config-restore-confirm">
                <p>将此文件恢复到保存前的内容？</p>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(backup.id)}
                >
                  确认恢复
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRestoring(null)}
                >
                  取消
                </button>
              </div>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}
