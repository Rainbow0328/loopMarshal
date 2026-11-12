import { Icon } from "@/components/Icon";
import { Dialog, ErrorState, Loading } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";
import { useSessionUpdates } from "@/lib/session-updates";
import type {
  ConsoleMember,
  DeliveryEvent,
  MessageRecord,
  ProxyDelivery,
} from "@loopmarshal/protocol";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openActivityWindow } from "./activity-window";
import { userHostConversation } from "./conversation";
import { extractReadableText, formatTimeFull, truncateText } from "./text";
import { useConsoleQuery, useMessagesQuery } from "./workbench-queries";

const activeStates = new Set(["queued", "delivering", "awaiting_result"]);
const deliveryLabels: Record<string, string> = {
  queued: "任务已排队",
  delivering: "正在启动工具",
  awaiting_result: "正在执行",
  completed: "任务已回报",
  failed: "执行失败",
  blocked: "等待处理",
  unknown: "执行结果待核对",
  cancelled: "任务已取消",
  superseded: "任务已替换",
};
const messageLabels: Record<string, string> = {
  task: "下发任务",
  instruction: "发送指令",
  result: "提交回报",
  progress: "更新进度",
  system: "发送通知",
  error: "报告异常",
  ack: "确认接收",
};
const receiptLabels: Record<string, string> = {
  pending: "等待接收",
  claimed: "开始处理",
  processed: "已处理",
  failed: "处理失败",
};
type ActivityItem = {
  id: string;
  time: string;
  title: string;
  text?: string;
  tone?: "error" | "success";
  message?: MessageRecord;
};

export function SessionActivity({
  sessionId,
  memberId,
  standalone = false,
  onHistory,
  onClose,
}: {
  sessionId: string;
  memberId?: string;
  standalone?: boolean;
  onHistory: () => void;
  onClose?: () => void;
}) {
  const consoleQuery = useConsoleQuery(sessionId);
  const messagesQuery = useMessagesQuery(sessionId, {
    refetchOnMount: "always",
  });
  const deliveries = useQuery({
    queryKey: ["deliveries", sessionId],
    queryFn: () => getApiClient().listDeliveries(sessionId),
    refetchInterval: 3000,
    refetchOnMount: "always",
  });
  const status = useSessionUpdates(sessionId);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [detail, setDetail] = useState<MessageRecord | null>(null);
  const [ready, setReady] = useState(false);
  const openedAt = useRef(new Date().toISOString());
  const messageStates = useRef<Map<string, string> | null>(null);
  const deliveryStates = useRef<Map<string, string> | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  const members = consoleQuery.data?.members;
  const agentMap = useMemo(
    () => new Map((members ?? []).map((member) => [member.agentId, member])),
    [members],
  );
  const name = useCallback(
    (id?: string) =>
      id ? (agentMap.get(id)?.displayName ?? "会话成员") : "全体成员",
    [agentMap],
  );
  const append = useCallback((events: ActivityItem[]) => {
    if (events.length)
      setItems((previous) => {
        const ids = new Set(previous.map((item) => item.id));
        const added = events.filter((event) => {
          if (ids.has(event.id)) return false;
          ids.add(event.id);
          return true;
        });
        return added.length
          ? [...previous, ...added]
              .sort((a, b) => a.time.localeCompare(b.time))
              .slice(-120)
          : previous;
      });
  }, []);

  useEffect(() => {
    if (!messagesQuery.data || !members || !messagesQuery.isFetchedAfterMount)
      return;
    const messages = messagesQuery.data;
    const hostId = members.find((member) => member.role === "host")?.agentId;
    const conversationIds = new Set(
      userHostConversation(messages, hostId).map((message) => message.id),
    );
    const previous = messageStates.current;
    messageStates.current = new Map(
      messages.map((message) => [message.id, message.processingStatus]),
    );
    if (!previous) setReady(true);
    const added: ActivityItem[] = [];
    for (const message of messages) {
      if (
        conversationIds.has(message.id) ||
        message.type === "heartbeat" ||
        (memberId &&
          message.fromAgentId !== memberId &&
          message.toAgentId !== memberId)
      )
        continue;
      const old = previous?.get(message.id);
      if (!old && message.createdAt >= openedAt.current)
        added.push({
          id: `message:${message.id}`,
          time: message.createdAt,
          title: `${name(message.fromAgentId)} → ${name(message.toAgentId)}`,
          text: `${messageLabels[message.type] ?? "发送消息"} · ${truncateText(extractReadableText(message.payload).replace(/\s+/g, " "), 180)}`,
          message,
          tone:
            message.type === "error" || message.processingStatus === "failed"
              ? "error"
              : message.type === "result"
                ? "success"
                : undefined,
        });
      else if (
        old &&
        old !== message.processingStatus &&
        (message.failedAt ?? message.processedAt ?? message.claimedAt ?? "") >=
          openedAt.current
      )
        added.push({
          id: `receipt:${message.id}:${message.processingStatus}`,
          time: message.failedAt ?? message.processedAt ?? message.claimedAt!,
          title: `${name(message.toAgentId)} · ${receiptLabels[message.processingStatus] ?? "更新了消息状态"}`,
          text: truncateText(
            extractReadableText(message.payload).replace(/\s+/g, " "),
            100,
          ),
          message,
          tone: message.processingStatus === "failed" ? "error" : undefined,
        });
    }
    append(added);
  }, [
    messagesQuery.data,
    messagesQuery.isFetchedAfterMount,
    members,
    memberId,
    name,
    append,
  ]);

  useEffect(() => {
    if (!deliveries.data) return;
    const previous = deliveryStates.current;
    deliveryStates.current = new Map(
      deliveries.data.map((delivery) => [delivery.id, delivery.state]),
    );
    append(
      deliveries.data
        .filter(
          (delivery) =>
            (!memberId || delivery.targetAgentId === memberId) &&
            previous?.get(delivery.id) !== delivery.state &&
            delivery.updatedAt >= openedAt.current,
        )
        .map((delivery) => ({
          id: `delivery:${delivery.id}:${delivery.attemptId}:${delivery.state}`,
          time: delivery.updatedAt,
          title: `${name(delivery.targetAgentId)} · ${deliveryLabels[delivery.state]}`,
          tone: ["failed", "blocked", "unknown"].includes(delivery.state)
            ? ("error" as const)
            : delivery.state === "completed"
              ? ("success" as const)
              : undefined,
        })),
    );
  }, [deliveries.data, memberId, name, append]);

  useEffect(() => {
    const node = stream.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items]);
  const running = (deliveries.data ?? []).filter(
    (delivery) =>
      activeStates.has(delivery.state) &&
      (!memberId || delivery.targetAgentId === memberId),
  );
  const localRunning = (members ?? []).filter(
    (member) =>
      member.route?.accessMode !== "managed_proxy" &&
      member.currentTask &&
      member.claimedCount > 0 &&
      (!memberId || member.agentId === memberId),
  );
  const error = messagesQuery.error ?? consoleQuery.error ?? deliveries.error;
  return (
    <section
      className={`session-activity ${standalone ? "is-standalone" : ""}`}
      aria-label={standalone ? "运行观察" : "实时动态"}
    >
      <header className="activity-heading">
        <div>
          <span
            className={`activity-indicator ${status === "connected" ? "is-connected" : ""}`}
          />
          <h2>{standalone ? "运行观察" : "实时动态"}</h2>
          <span className="activity-connection">
            {status === "connected" ? "实时连接" : "定时更新"}
          </span>
        </div>
        <div>
          {!standalone && (
            <button
              className="btn btn-ghost btn-icon"
              aria-label="独立窗口查看运行"
              title="独立窗口查看运行"
              onClick={() => void openActivityWindow(sessionId, memberId)}
            >
              <Icon name="external" size={17} />
            </button>
          )}
          {onClose && (
            <button
              className="btn btn-ghost btn-icon"
              aria-label="关闭实时动态"
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
      </header>
      {standalone && (
        <div className="observer-identity">
          <strong>
            {memberId
              ? name(memberId)
              : (consoleQuery.data?.session.name ?? "当前会话")}
          </strong>
          <p>同一任务的只读视图，关闭窗口后任务继续执行。</p>
        </div>
      )}
      <div className="activity-running" aria-label="当前执行">
        <div className="activity-running-heading">
          <strong>当前执行</strong>
          <span>{running.length + localRunning.length} 项</span>
        </div>
        {running.map((delivery) => (
          <div className="activity-running-row" key={delivery.id}>
            <Icon name="terminal" size={16} />
            <div>
              <strong>{name(delivery.targetAgentId)}</strong>
              <span>
                {delivery.snapshot.installation.displayName} ·{" "}
                {deliveryLabels[delivery.state]}
              </span>
            </div>
            {!standalone && (
              <button
                className="btn-link"
                onClick={() =>
                  void openActivityWindow(sessionId, delivery.targetAgentId)
                }
              >
                查看运行
              </button>
            )}
            <ExecutionEvents
              delivery={delivery}
              name={name(delivery.targetAgentId)}
              openedAt={openedAt.current}
              onEvents={append}
            />
          </div>
        ))}
        {localRunning.map((member) => (
          <LocalRunning key={member.agentId} member={member} />
        ))}
        {!running.length && !localRunning.length && (
          <p className="activity-idle">暂无执行中的任务</p>
        )}
      </div>
      {error && (
        <ErrorState
          message="动态读取暂时中断，正在重新连接。"
          onRetry={() => {
            void messagesQuery.refetch();
            void deliveries.refetch();
            void consoleQuery.refetch();
          }}
        />
      )}
      <div
        className="activity-stream"
        ref={stream}
        role="log"
        aria-label="本次打开后的新动态"
        aria-live="off"
      >
        {!ready && !error && <Loading text="正在连接当前会话…" />}
        {ready && !items.length && (
          <div className="activity-empty">
            <Icon name="activity" size={30} />
            <strong>正在关注新的协作动态</strong>
            <p>成员的新消息、接收和回报将在这里连续出现。</p>
            <span>从本次打开开始记录</span>
          </div>
        )}
        {items.map((item) => (
          <article
            key={item.id}
            className={`activity-item ${item.tone ? `activity-${item.tone}` : ""}`}
            data-activity-id={item.id}
          >
            <span className="activity-point" />
            <div className="activity-item-heading">
              <strong>{item.title}</strong>
              <time title={formatTimeFull(item.time)}>
                {new Date(item.time).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </time>
            </div>
            {item.text && <p>{item.text}</p>}
            {item.message && (
              <button
                className="btn-link"
                onClick={() => setDetail(item.message!)}
              >
                查看详情
              </button>
            )}
          </article>
        ))}
      </div>
      <footer className="activity-footer">
        <span>持续跟随最新动态 · 最近 120 条</span>
        <button className="btn btn-secondary btn-sm" onClick={onHistory}>
          <Icon name="search" size={14} />
          查看对话历史
        </button>
      </footer>
      <Dialog
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title="动态详情"
        width={760}
      >
        {detail && (
          <>
            <p className="muted-copy">
              {name(detail.fromAgentId)} → {name(detail.toAgentId)}
            </p>
            <article
              className="markdown-body"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(extractReadableText(detail.payload)),
              }}
            />
          </>
        )}
      </Dialog>
    </section>
  );
}

function LocalRunning({ member }: { member: ConsoleMember }) {
  return (
    <div className="activity-running-row">
      <Icon name="model" size={16} />
      <div>
        <strong>{member.displayName}</strong>
        <span>
          {member.route?.accessMode === "core_runtime"
            ? "本地 Agent"
            : "外部编程工具"}{" "}
          · 正在处理消息
        </span>
      </div>
    </div>
  );
}

const eventLabels: Record<string, string> = {
  process_started: "工具进程已启动",
  "thread.started": "已接续工具会话",
  tool_activity: "工具正在执行操作",
  "item.started": "工具开始处理",
  "item.completed": "工具更新了执行进度",
  "turn.failed": "工具报告执行异常",
  fatal_error: "工具报告执行异常",
};
function ExecutionEvents({
  delivery,
  name,
  openedAt,
  onEvents,
}: {
  delivery: ProxyDelivery;
  name: string;
  openedAt: string;
  onEvents: (events: ActivityItem[]) => void;
}) {
  const cursor = useRef<number | null>(null);
  const events = useQuery({
    queryKey: ["observation-events", delivery.id],
    queryFn: () =>
      getApiClient().getDeliveryEvents(delivery.id, cursor.current ?? 0),
    refetchInterval: 1000,
    refetchOnMount: "always",
  });
  useEffect(() => {
    if (!events.data) return;
    const after = cursor.current;
    cursor.current = Math.max(
      after ?? 0,
      ...events.data.map((event) => event.sequence),
    );
    onEvents(
      events.data
        .filter(
          (event) =>
            event.sequence > (after ?? 0) &&
            event.createdAt >= openedAt &&
            eventLabels[event.type],
        )
        .map((event: DeliveryEvent) => ({
          id: `event:${delivery.id}:${event.sequence}`,
          time: event.createdAt,
          title: `${name} · ${eventLabels[event.type]}`,
          tone: ["turn.failed", "fatal_error"].includes(event.type)
            ? "error"
            : undefined,
        })),
    );
  }, [events.data, delivery.id, name, openedAt, onEvents]);
  return null;
}
