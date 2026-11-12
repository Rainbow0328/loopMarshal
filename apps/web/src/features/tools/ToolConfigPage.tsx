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
  toolDescriptions,
  toolNames,
  type ToolConfigProfile,
  type ToolDiscoveryCandidate,
  type ToolInstallation,
} from "@loopmarshal/protocol";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ToolCompatibilityNotice } from "./ToolCompatibilityNotice";

import { ProfileEditor } from "./ProfileEditor";

export function ToolConfigPage() {
  const { installationId: requestedInstallationId } = useSearch({
    from: "/tool-config",
  });
  const api = getApiClient();
  const qc = useQueryClient();
  const installations = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => api.listToolInstallations(),
  });
  const profiles = useQuery({
    queryKey: ["tool-config-profiles"],
    queryFn: () => api.listToolConfigProfiles(),
  });
  const [selectedInstallationId, setSelectedInstallationId] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [preparingProfile, setPreparingProfile] = useState(false);
  const [dirty, setDirty] = useState(false);
  const allowSwitch = () =>
    !dirty || window.confirm("当前修改尚未保存，确认放弃修改并切换？");
  const autoProfileAttempted = useRef(new Set<string>());
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [configRoot, setConfigRoot] = useState("");
  const [profileName, setProfileName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const selectedInstallation =
    installations.data?.find((item) => item.id === selectedInstallationId) ??
    null;
  const selectedProfiles = useMemo(
    () =>
      profiles.data?.profiles.filter(
        (profile) => profile.installationId === selectedInstallationId,
      ) ?? [],
    [profiles.data?.profiles, selectedInstallationId],
  );
  const selectedProfile =
    selectedProfiles.find((profile) => profile.id === selectedProfileId) ??
    null;

  useEffect(() => {
    if (
      requestedInstallationId &&
      installations.data?.some((item) => item.id === requestedInstallationId)
    ) {
      setSelectedInstallationId(requestedInstallationId);
    }
  }, [installations.data, requestedInstallationId]);
  useEffect(() => {
    if (
      !selectedInstallationId &&
      installations.data?.[0] &&
      !installations.data.some((item) => item.id === requestedInstallationId)
    )
      setSelectedInstallationId(installations.data[0].id);
  }, [installations.data, selectedInstallationId, requestedInstallationId]);
  useEffect(() => {
    const first = selectedProfiles[0];
    if (creatingProfile) return;
    if (
      selectedProfileId &&
      selectedProfiles.some((profile) => profile.id === selectedProfileId)
    )
      return;
    setSelectedProfileId(first?.id ?? "");
  }, [creatingProfile, selectedProfileId, selectedProfiles]);
  useEffect(() => {
    if (!selectedInstallation) return;
    const defaultRoot =
      profiles.data?.defaults[selectedInstallation.toolId] ?? "";
    setConfigRoot(defaultRoot);
    setProfileName(`${selectedInstallation.displayName} 配置`);
    setWorkspace("");
    setCreatingProfile(false);
    setPreparingProfile(false);
  }, [selectedInstallation?.id, profiles.data?.defaults]);

  const scan = useMutation({
    mutationFn: () => api.discoverTools(),
    onSuccess: () => setShowDiscovery(true),
  });
  const register = useMutation({
    mutationFn: (candidate: ToolDiscoveryCandidate) =>
      api.createToolInstallation({
        toolId: candidate.toolId,
        displayName: toolNames[candidate.toolId],
        executablePath: candidate.executablePath,
      }),
    onSuccess: async (result, candidate) => {
      autoProfileAttempted.current.add(result.id);
      await qc.invalidateQueries({ queryKey: ["tool-installations"] });
      setSelectedInstallationId(result.id);
      setSelectedProfileId("");
      setPreparingProfile(false);
      const root =
        candidate.suggestedConfigRoot ||
        profiles.data?.defaults[result.toolId] ||
        "";
      if (root) {
        try {
          const created = await api.createToolConfigProfile({
            installationId: result.id,
            configRoot: root,
            workspacePath: null,
            name: `${result.displayName} 配置`,
          });
          await qc.invalidateQueries({ queryKey: ["tool-config-profiles"] });
          setSelectedProfileId(created.profile.id);
          setCreatingProfile(false);
          setShowDiscovery(false);
          pushToast(`${result.displayName} 已加入配置中心`, "success");
          return;
        } catch {
          setCreatingProfile(true);
          setShowDiscovery(false);
          pushToast("工具已加入，请确认它的工具配置目录", "info");
          return;
        }
      }
      setCreatingProfile(true);
      setShowDiscovery(false);
      pushToast("工具已加入，请指定工具配置目录", "info");
    },
  });
  const createProfile = useMutation({
    mutationFn: () => {
      if (!selectedInstallationId) throw new Error("请先选择一个工具。");
      return api.createToolConfigProfile({
        installationId: selectedInstallationId,
        configRoot: configRoot.trim(),
        workspacePath: workspace.trim() || null,
        name: profileName.trim(),
      });
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["tool-config-profiles"] });
      setSelectedProfileId(result.profile.id);
      setCreatingProfile(false);
      pushToast("工具配置已建立", "success");
    },
  });
  useEffect(() => {
    if (
      !selectedInstallation ||
      profiles.isLoading ||
      selectedProfiles.length ||
      creatingProfile ||
      preparingProfile
    )
      return;
    if (autoProfileAttempted.current.has(selectedInstallation.id)) return;
    const defaultRoot =
      profiles.data?.defaults[selectedInstallation.toolId] ?? "";
    if (!defaultRoot) {
      autoProfileAttempted.current.add(selectedInstallation.id);
      setCreatingProfile(true);
      return;
    }
    autoProfileAttempted.current.add(selectedInstallation.id);
    setPreparingProfile(true);
    void api
      .createToolConfigProfile({
        installationId: selectedInstallation.id,
        configRoot: defaultRoot,
        workspacePath: null,
        name: `${selectedInstallation.displayName} 配置`,
      })
      .then(async (result) => {
        await qc.invalidateQueries({ queryKey: ["tool-config-profiles"] });
        setSelectedProfileId(result.profile.id);
        setPreparingProfile(false);
        pushToast("已打开工具配置，可直接编辑服务地址、密钥和模型", "success");
      })
      .catch(() => {
        setPreparingProfile(false);
        setCreatingProfile(true);
      });
  }, [
    api,
    creatingProfile,
    preparingProfile,
    profiles.data?.defaults,
    profiles.isLoading,
    qc,
    selectedInstallation,
    selectedProfiles.length,
  ]);
  const error =
    installations.error ??
    profiles.error ??
    scan.error ??
    register.error ??
    createProfile.error;

  return (
    <>
      <PageHeader
        title="工具配置"
        subtitle="统一设置工具的模型、地址与密钥"
        actions={
          <>
            <Link className="btn btn-ghost" to="/tools">
              <Icon name="arrow" size={15} />
              返回发现 Worker
            </Link>
            <button
              className="btn btn-primary"
              onClick={() => scan.mutate()}
              disabled={scan.isPending}
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
            onRetry={() => {
              void installations.refetch();
              void profiles.refetch();
            }}
          />
        )}
        <div className="tool-config-layout">
          <aside className="tool-config-sidebar">
            <div className="section-heading">
              <div>
                <h2>本机工具</h2>
                <p>选择要配置的 Worker</p>
              </div>
              <Badge>{installations.data?.length ?? 0}</Badge>
            </div>
            {installations.isLoading ? (
              <Loading />
            ) : installations.data?.length ? (
              <div className="tool-config-tool-list">
                {installations.data.map((installation) => {
                  const count =
                    profiles.data?.profiles.filter(
                      (profile) => profile.installationId === installation.id,
                    ).length ?? 0;
                  return (
                    <button
                      key={installation.id}
                      aria-label={`选择 ${installation.displayName}`}
                      className={`tool-config-tool ${selectedInstallationId === installation.id ? "is-active" : ""}`}
                      onClick={() => {
                        if (
                          selectedInstallationId === installation.id ||
                          !allowSwitch()
                        )
                          return;
                        setDirty(false);
                        setSelectedInstallationId(installation.id);
                        setSelectedProfileId("");
                        setCreatingProfile(false);
                        setPreparingProfile(false);
                      }}
                    >
                      <span
                        className={`tool-monogram tool-${installation.toolId}`}
                      >
                        {toolNames[installation.toolId].slice(0, 1)}
                      </span>
                      <span>
                        <strong>{installation.displayName}</strong>
                        <small>
                          {toolNames[installation.toolId]} ·{" "}
                          {count ? `${count} 份配置` : "尚未配置"}
                        </small>
                      </span>
                      <Icon name="chevron" size={14} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="暂无本机工具"
                desc="发现本机 Worker 后，即可编辑它的模型与连接设置。"
                action={
                  <Link className="btn btn-secondary" to="/tools">
                    前往发现 Worker
                  </Link>
                }
              />
            )}
            <button
              className="tool-config-scan-link"
              onClick={() => scan.mutate()}
            >
              <Icon name="search" size={15} />
              发现更多工具
            </button>
          </aside>
          <main className="tool-config-editor">
            {selectedInstallation ? (
              <>
                <div className="tool-config-editor-heading">
                  <div className="tool-config-identity">
                    <span
                      className={`tool-monogram tool-${selectedInstallation.toolId}`}
                    >
                      {toolNames[selectedInstallation.toolId].slice(0, 1)}
                    </span>
                    <div>
                      <span className="eyebrow-label">正在配置</span>
                      <h2>{selectedInstallation.displayName}</h2>
                      <p>{toolDescriptions[selectedInstallation.toolId]}</p>
                    </div>
                  </div>
                </div>
                <ToolCompatibilityNotice
                  toolId={selectedInstallation.toolId}
                  compatibility={selectedInstallation.compatibility}
                  installationId={selectedInstallation.id}
                />
                {selectedProfiles.length > 0 && (
                  <div className="tool-config-profile-tabs">
                    {selectedProfiles.map((profile) => (
                      <button
                        key={profile.id}
                        className={
                          selectedProfileId === profile.id && !creatingProfile
                            ? "is-active"
                            : ""
                        }
                        onClick={() => {
                          if (!allowSwitch()) return;
                          setDirty(false);
                          setCreatingProfile(false);
                          setSelectedProfileId(profile.id);
                        }}
                      >
                        <Icon name="file" size={15} />
                        {profile.name}
                      </button>
                    ))}
                    <button
                      className={creatingProfile ? "is-active" : ""}
                      onClick={() => {
                        if (!allowSwitch()) return;
                        setDirty(false);
                        setCreatingProfile(true);
                        setSelectedProfileId("");
                      }}
                    >
                      <Icon name="plus" size={15} />
                      其他配置目录
                    </button>
                  </div>
                )}
                {selectedProfile ? (
                  <ProfileEditor
                    key={selectedProfile.id}
                    profile={selectedProfile}
                    onDirtyChange={setDirty}
                  />
                ) : preparingProfile ? (
                  <section className="config-panel tool-config-preparing">
                    <Loading text="正在打开工具配置…" />
                    <p>
                      正在定位该工具的默认配置文件，马上就可以编辑服务地址、密钥和模型。
                    </p>
                  </section>
                ) : (
                  <NewProfileForm
                    installation={selectedInstallation}
                    configRoot={configRoot}
                    setConfigRoot={setConfigRoot}
                    profileName={profileName}
                    setProfileName={setProfileName}
                    workspace={workspace}
                    setWorkspace={setWorkspace}
                    mutation={createProfile}
                  />
                )}
              </>
            ) : (
              <EmptyState
                title="选择一个 Worker"
                desc="左侧会列出已接入的 Codex、Claude Code 等工具。"
              />
            )}
          </main>
        </div>
        {showDiscovery && scan.data && (
          <DiscoveryDialog
            candidates={scan.data.candidates}
            installations={installations.data ?? []}
            onClose={() => setShowDiscovery(false)}
            onRegister={(candidate) => register.mutate(candidate)}
            pending={register.isPending}
          />
        )}
      </PageContainer>
    </>
  );
}

function NewProfileForm({
  installation,
  configRoot,
  setConfigRoot,
  profileName,
  setProfileName,
  workspace,
  setWorkspace,
  mutation,
}: {
  installation: ToolInstallation;
  configRoot: string;
  setConfigRoot: (value: string) => void;
  profileName: string;
  setProfileName: (value: string) => void;
  workspace: string;
  setWorkspace: (value: string) => void;
  mutation: Pick<
    UseMutationResult<{ profile: ToolConfigProfile }, Error, void, unknown>,
    "isPending" | "mutate"
  >;
}) {
  return (
    <section className="config-panel tool-config-new-profile">
      <div className="section-heading">
        <div>
          <span className="eyebrow-label">
            首次配置 · {toolNames[installation.toolId]}
          </span>
          <h2>选择配置目录</h2>
          <p>
            确认目录后，显示此工具支持编辑的配置。登录与密钥的管理方式见上方说明。
          </p>
        </div>
        <Icon name="settings" size={25} />
      </div>
      <form
        className="config-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(undefined);
        }}
      >
        <Field label="配置名称" required hint="例如：工作账号、项目 A。">
          <input
            className="input"
            required
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
          />
        </Field>
        <Field
          label="工具配置目录"
          required
          hint="填写该工具实际读取的配置文件夹。"
        >
          <input
            className="input"
            required
            value={configRoot}
            onChange={(event) => setConfigRoot(event.target.value)}
            placeholder="例如 C:\Users\你\.codex"
          />
        </Field>
        <Field label="项目目录（可选）" hint="需要单独维护项目配置时填写。">
          <input
            className="input"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="项目文件夹的完整路径"
          />
        </Field>
        <div className="notice">
          <Icon name="info" size={17} />
          <p>
            目录关系只需确认一次，不会移动或改写文件。下一步即可在本页编辑模型、服务地址与
            API 密钥。
          </p>
        </div>
        <div className="config-form-actions">
          <button
            className="btn btn-primary"
            disabled={
              mutation.isPending || !profileName.trim() || !configRoot.trim()
            }
          >
            <Icon name="arrow" size={15} />
            {mutation.isPending ? "正在打开…" : "继续设置模型与密钥"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DiscoveryDialog({
  candidates,
  installations,
  onClose,
  onRegister,
  pending,
}: {
  candidates: ToolDiscoveryCandidate[];
  installations: ToolInstallation[];
  onClose: () => void;
  onRegister: (candidate: ToolDiscoveryCandidate) => void;
  pending: boolean;
}) {
  return (
    <Dialog open onClose={onClose} title="发现 Worker" width={700}>
      <p className="muted-copy">
        选择要加入列表的 Worker。加入后可以直接维护它的模型和密钥配置。
      </p>
      {candidates.length ? (
        candidates.map((candidate) => {
          const registered =
            candidate.registeredInstallationId ||
            installations.find(
              (item) =>
                item.toolId === candidate.toolId &&
                item.executablePath === candidate.executablePath,
            )?.id;
          return (
            <div
              className="discovery-tool-row"
              key={candidate.toolId + candidate.executablePath}
            >
              <span className={`tool-monogram tool-${candidate.toolId}`}>
                {toolNames[candidate.toolId].slice(0, 1)}
              </span>
              <div>
                <strong>{toolNames[candidate.toolId]}</strong>
                <code>{candidate.executablePath}</code>
                <ToolCompatibilityNotice
                  toolId={candidate.toolId}
                  compatibility={candidate.compatibility}
                />
              </div>
              <button
                className="btn btn-secondary btn-sm"
                disabled={pending || Boolean(registered)}
                onClick={() => onRegister(candidate)}
              >
                {registered ? "已添加" : "添加并配置"}
              </button>
            </div>
          );
        })
      ) : (
        <EmptyState
          title="没有发现新的 Worker"
          desc="请先确认工具已安装，或前往“发现 Worker”页面手动登记。"
        />
      )}
    </Dialog>
  );
}
