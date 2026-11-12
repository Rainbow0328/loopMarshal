import { Icon } from "@/components/Icon";
import { Badge, ErrorState, Loading } from "@/components/ui";
import type {
  ConsoleMember,
  ConsoleTaskThread,
  SessionConsole,
  SessionInsight,
  WebAgentRuntime,
} from "@loopmarshal/protocol";
import { Link } from "@tanstack/react-router";
import { memberState } from "./member-state";
import { formatTime, truncateText } from "./text";
import { getRuntimeForAgent } from "./workbench-queries";

const reviewLabels = {
  in_progress: "推进中",
  blocked: "存在阻塞",
  needs_user_input: "等待你的补充",
  ready_for_review: "等待你的验收",
};
const taskLabels = {
  pending: "待处理",
  working: "执行中",
  reported: "已回报 · 待 Host 验收",
  failed: "执行失败",
};

export function SessionOverview({
  data,
  insight,
  loading,
  error,
  runtimes,
  onSelectMember,
  onOpenTask,
  onManage,
  onRetry,
}: {
  data: SessionConsole;
  insight: SessionInsight | null;
  loading: boolean;
  error?: Error | null;
  runtimes: WebAgentRuntime[];
  onSelectMember: (member: ConsoleMember) => void;
  onOpenTask: (thread: ConsoleTaskThread) => void;
  onManage: () => void;
  onRetry: () => void;
}) {
  const keeper = data.members.find(
    (member) => member.role === "knowledge_keeper",
  );
  return (
    <div className="overview-content">
      <div className="overview-heading">
        {insight && (
          <Badge
            variant={
              insight.reviewStatus === "blocked"
                ? "error"
                : insight.readyForReview
                  ? "warning"
                  : "info"
            }
          >
            {reviewLabels[insight.reviewStatus]}
          </Badge>
        )}
      </div>
      <section className="overview-section">
        <div className="overview-label">
          <Icon name="folder" size={15} />
          目标与计划
        </div>
        {loading ? (
          <Loading text="读取会话认知…" />
        ) : error ? (
          <ErrorState message={error.message} onRetry={onRetry} />
        ) : (
          <>
            <h3>{insight?.objective ?? "尚未记录目标"}</h3>
            <p className="overview-copy">
              {insight?.activePlanSummary ??
                "与 Host 明确目标后，计划和验收条件会记录在这里。"}
            </p>
            {insight?.reviewReason && (
              <p className="review-reason">{insight.reviewReason}</p>
            )}
            {insight && insight.blockers.length > 0 && (
              <div className="overview-blockers">
                <strong>需要处理</strong>
                <ul>
                  {insight.blockers.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {insight && insight.unappliedUserInputs.length > 0 && (
              <p className="review-reason">
                {insight.unappliedUserInputs.length} 条补充意见待 Host 纳入计划
              </p>
            )}
            {insight &&
              (insight.acceptanceCriteria.length > 0 ||
                insight.completedItems.length > 0 ||
                insight.pendingItems.length > 0 ||
                insight.constraints.length > 0) && (
                <details className="overview-plan">
                  <summary>计划与验收条件</summary>
                  {(
                    [
                      ["已记录完成项", insight.completedItems],
                      ["待办事项", insight.pendingItems],
                      ["验收条件", insight.acceptanceCriteria],
                      ["约束", insight.constraints],
                    ] as const
                  )
                    .filter(([, items]) => items.length > 0)
                    .map(([label, items]) => (
                      <div key={label}>
                        <strong>{label}</strong>
                        <ul>
                          {items.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </details>
              )}
          </>
        )}
      </section>
      <section className="overview-section">
        <div className="overview-label">
          <Icon name="activity" size={15} />
          最近任务
        </div>
        {data.taskThreads.length ? (
          data.taskThreads.slice(0, 4).map((thread) => (
            <button
              className="task-preview"
              key={thread.hostMessage.messageId}
              onClick={() => onOpenTask(thread)}
              aria-label={`查看任务 ${thread.workerName ?? "未分配"} ${truncateText(thread.hostMessage.content, 50)}`}
            >
              <div>
                <strong>{thread.workerName ?? "未分配"}</strong>
                <small>{taskLabels[thread.status]}</small>
              </div>
              <p>{truncateText(thread.hostMessage.content, 110)}</p>
              {thread.workerReport && (
                <span className="task-report-preview">
                  回报：{truncateText(thread.workerReport.content, 90)}
                </span>
              )}
            </button>
          ))
        ) : (
          <p className="overview-empty">
            Host 分配任务后，可在这里查看原任务和成员回报。
          </p>
        )}
      </section>
      <section className="overview-section">
        <div className="overview-label">
          <Icon name="people" size={15} />
          协作团队 · {data.members.length} 位
        </div>
        <div className="team-preview">
          {data.members.map((member) => {
            const state = memberState(
              member,
              getRuntimeForAgent(runtimes, member.agentId),
            );
            return (
              <button
                key={member.agentId}
                className="team-preview-row"
                onClick={() =>
                  member.role === "host" ? onManage() : onSelectMember(member)
                }
              >
                <span className={`agent-avatar avatar-${member.role}`}>
                  <Icon
                    name={
                      member.role === "host"
                        ? "workspace"
                        : member.role === "knowledge_keeper"
                          ? "book"
                          : "terminal"
                    }
                    size={16}
                  />
                </span>
                <span className="team-preview-copy">
                  <strong>{member.displayName}</strong>
                  <small>
                    {member.role === "host"
                      ? "主控"
                      : member.role === "knowledge_keeper"
                        ? "知识维护"
                        : "执行者"}{" "}
                    · {state.label}
                  </small>
                </span>
                <span
                  className={`status-dot status-${state.variant}`}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onManage}>
          管理接入与投递
          <Icon name="chevron" size={13} />
        </button>
      </section>
      <section className="overview-section">
        <div className="overview-label">
          <Icon name="book" size={15} />
          知识库
        </div>
        <p className="overview-copy">
          {keeper
            ? `由 ${keeper.displayName} 与 Host 维护`
            : "由 Host 维护，可按需添加知识库维护者"}
        </p>
        <div className="knowledge-level-counts">
          {(["l1", "l2", "l3"] as const).map((level) => (
            <span key={level}>
              {level.toUpperCase()}{" "}
              <strong>{data.knowledgeSummary.counts[level]}</strong>
            </span>
          ))}
        </div>
        {data.knowledgeSummary.recentChanges.slice(0, 2).map((change) => (
          <p
            className="knowledge-recent"
            key={`${change.level}/${change.slug}/${change.createdAt}`}
          >
            {change.summary ?? `${change.level}/${change.slug}`}
            <time>{formatTime(change.createdAt)}</time>
          </p>
        ))}
        <Link to="/knowledge" className="overview-link">
          阅读知识与变更
          <Icon name="chevron" size={13} />
        </Link>
      </section>
    </div>
  );
}
