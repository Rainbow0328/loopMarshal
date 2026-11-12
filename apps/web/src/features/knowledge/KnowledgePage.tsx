import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  pushToast,
} from "@/components/ui";
import { formatTimeFull } from "@/features/workbench/text";
import {
  getSelectedSessionId,
  useConsoleQuery,
  useSessionsQuery,
} from "@/features/workbench/workbench-queries";
import { api } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";
import { useSelectedSession } from "@/lib/selected-session";
import { SESSION_FALLBACK_REFETCH_MS } from "@/lib/session-query-keys";
import { useSessionUpdates } from "@/lib/session-updates";
import {
  knowledgeLevelDefinitions,
  type KnowledgeLevel,
} from "@loopmarshal/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
const LEVELS: Record<
  KnowledgeLevel,
  {
    label: string;
    description: string;
    variant: "warning" | "info" | "success";
  }
> = {
  l1: {
    ...knowledgeLevelDefinitions.l1,
    variant: "warning",
  },
  l2: { ...knowledgeLevelDefinitions.l2, variant: "info" },
  l3: {
    ...knowledgeLevelDefinitions.l3,
    variant: "success",
  },
};
export function KnowledgePage() {
  const [explicitSessionId, setSessionId] = useSelectedSession();
  const sessionsQuery = useSessionsQuery();
  const sessions = sessionsQuery.data ?? [];
  const sessionId = getSelectedSessionId(sessions, explicitSessionId);
  useSessionUpdates(sessionId);
  if (sessionsQuery.error)
    return (
      <>
        <PageHeader title="知识库" />
        <ErrorState
          message={sessionsQuery.error.message}
          onRetry={() => {
            void sessionsQuery.refetch();
          }}
        />
      </>
    );
  return (
    <KnowledgeSessionView
      key={sessionId ?? "none"}
      sessionId={sessionId}
      sessions={sessions}
      onSelectSession={setSessionId}
    />
  );
}
function KnowledgeSessionView({
  sessionId,
  sessions,
  onSelectSession,
}: {
  sessionId: string | null;
  sessions: Array<{ id: string; name: string }>;
  onSelectSession: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const consoleQuery = useConsoleQuery(sessionId);
  const keeper = consoleQuery.data?.members.find(
    (member) => member.role === "knowledge_keeper",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const manifest = useQuery({
    queryKey: ["knowledge", sessionId, "manifest"],
    queryFn: () => api.knowledge.getManifest(sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
  const list = useQuery({
    queryKey: ["knowledge", sessionId, "list"],
    queryFn: () => api.knowledge.list({ sessionId: sessionId! }),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
  const changes = useQuery({
    queryKey: ["knowledge", sessionId, "changes"],
    queryFn: () =>
      api.knowledge.listChanges({ sessionId: sessionId!, limit: 30 }),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
  const items = list.data ?? [];
  const filtered = useMemo(
    () =>
      items.filter((item) =>
        `${item.title} ${item.slug}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [items, search],
  );
  const active =
    items.find((item) => `${item.level}/${item.slug}` === selected) ??
    items[0] ??
    null;
  const document = useQuery({
    queryKey: [
      "knowledge",
      sessionId,
      "doc",
      active?.level,
      active?.slug,
      active?.version,
    ],
    queryFn: () => api.knowledge.get(active!.level, active!.slug, sessionId!),
    enabled: Boolean(sessionId && active),
    refetchInterval: 5000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sessions"] });
    void qc.invalidateQueries({ queryKey: ["knowledge", sessionId] });
    pushToast("知识库已刷新", "info");
  };
  const error = list.error ?? manifest.error ?? document.error;
  return (
    <>
      <PageHeader
        title="知识库"
        subtitle="保存本会话已核实的项目知识"
        actions={
          <>
            <Link to="/" className="btn btn-ghost">
              <Icon name="arrow" size={15} />
              返回协作
            </Link>
            <button
              className="btn btn-secondary"
              onClick={() => setShowChanges(true)}
            >
              <Icon name="clock" size={15} />
              变更记录
            </button>
            <button className="btn btn-secondary" onClick={refresh}>
              <Icon name="refresh" size={15} />
              刷新
            </button>
          </>
        }
      />
      <div className="knowledge-toolbar">
        <div className="session-selector">
          <Icon name="folder" size={16} />
          <select
            className="input"
            aria-label="知识库会话"
            value={sessionId ?? ""}
            onChange={(event) => onSelectSession(event.target.value || null)}
          >
            {!sessions.length && <option value="">请先新建协作</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        </div>
        <span>
          <Icon name="shield" size={14} />
          当前会话独立保存
        </span>
        <span className="knowledge-count">{items.length} 篇文档</span>
      </div>
      {!sessionId ? (
        <EmptyState
          title="先选择一个协作会话"
          desc="知识随会话保存。先新建协作，或打开已有协作。"
        />
      ) : (
        <div className="knowledge-workspace">
          <aside className="knowledge-index" aria-label="知识文档目录">
            <div className="knowledge-search">
              <Icon name="search" size={16} />
              <input
                aria-label="搜索知识文档"
                placeholder="搜索文档…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {list.isLoading ? (
              <Loading />
            ) : items.length === 0 ? (
              <EmptyState
                title="知识库为空"
                desc="Host 或知识库维护者核实项目后，会将知识保存在这里。"
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="没有匹配的文档"
                desc="换一个标题或关键词试试。"
                action={
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSearch("")}
                  >
                    清除搜索
                  </button>
                }
              />
            ) : (
              (Object.keys(LEVELS) as KnowledgeLevel[]).map((level) => (
                <section className="knowledge-group" key={level}>
                  <h2>
                    <span className={`knowledge-level level-${level}`}>
                      {level.toUpperCase()}
                    </span>
                    {LEVELS[level].label}
                    <small>
                      {filtered.filter((item) => item.level === level).length}
                    </small>
                  </h2>
                  <div>
                    {filtered
                      .filter((item) => item.level === level)
                      .map((item) => (
                        <button
                          key={`${level}/${item.slug}`}
                          className={`knowledge-doc-link ${active?.level === level && active.slug === item.slug ? "is-active" : ""}`}
                          onClick={() => setSelected(`${level}/${item.slug}`)}
                        >
                          <Icon name="file" size={16} />
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.slug}</small>
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              ))
            )}
            <div className="knowledge-index-footer">
              <Icon name="info" size={14} />
              <span>
                {keeper
                  ? `由 ${keeper.displayName} 与 Host 维护。`
                  : "由 Host 维护。"}
                成员执行任务时读取当前会话的最新知识。
              </span>
            </div>
          </aside>
          <div className="knowledge-reader">
            {error && <ErrorState message={error.message} onRetry={refresh} />}
            {!active ? (
              <EmptyState
                icon={<Icon name="book" />}
                title="项目知识，从第一次协作开始积累"
                desc="项目方向、领域规则和字段契约按层次记录在这里；任务进度与验收记录保留在协作消息中。"
              />
            ) : document.isLoading ? (
              <Loading text="正在读取文档…" />
            ) : document.data ? (
              <>
                <div className="document-topline">
                  <Badge variant={LEVELS[active.level].variant}>
                    {active.level.toUpperCase()} / {LEVELS[active.level].label}
                  </Badge>
                  <span>版本 {active.version}</span>
                </div>
                <article className="knowledge-article">
                  <header>
                    <h2>{active.title}</h2>
                    <p>
                      <Icon name="clock" size={13} />
                      更新于 {formatTimeFull(active.updatedAt)}
                    </p>
                  </header>
                  {document.data.summary && (
                    <div className="document-summary">
                      {document.data.summary}
                    </div>
                  )}
                  {document.data.tags.length > 0 && (
                    <div className="document-tags">
                      {document.data.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(
                        document.data.content || "暂无文档内容",
                      ),
                    }}
                  />
                </article>
                <details className="document-location">
                  <summary>文档位置与范围</summary>
                  <code>
                    {manifest.data?.rootPath}/{active.level}/{active.slug}
                  </code>
                  <p>该文档仅用于当前协作会话。</p>
                </details>
              </>
            ) : (
              <EmptyState
                title="文档尚未读取成功"
                action={
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      void document.refetch();
                    }}
                  >
                    重新读取
                  </button>
                }
              />
            )}
          </div>
        </div>
      )}
      <Dialog
        open={showChanges}
        onClose={() => setShowChanges(false)}
        title="知识库变更记录"
        width={680}
      >
        <p className="muted-copy">仅显示当前会话最近的知识变更。</p>
        {changes.error && (
          <ErrorState
            message={changes.error.message}
            onRetry={() => {
              void changes.refetch();
            }}
          />
        )}
        {changes.isLoading ? (
          <Loading />
        ) : !changes.data?.length ? (
          <EmptyState title="暂无变更记录" />
        ) : (
          <div className="change-timeline">
            {changes.data.map((change) => (
              <div key={`${change.level}/${change.slug}/${change.createdAt}`}>
                <span className="timeline-dot" />
                <div>
                  <div className="change-heading">
                    <strong>
                      {change.level}/{change.slug}
                    </strong>
                    <Badge
                      variant={
                        change.kind === "created"
                          ? "success"
                          : change.kind === "deleted"
                            ? "error"
                            : "info"
                      }
                    >
                      {{ created: "新建", updated: "更新", deleted: "删除" }[
                        change.kind
                      ] ?? change.kind}
                    </Badge>
                  </div>
                  <time>{formatTimeFull(change.createdAt)}</time>
                  {change.summary && <p>{change.summary}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
