import { Badge, Dialog } from "@/components/ui";
import { renderMarkdown } from "@/lib/markdown";
import type {
  ConsoleMember,
  ConsoleTaskThread,
  MessageRecord,
} from "@loopmarshal/protocol";
import { isUserMessage } from "./conversation";
import { messageTypeLabels, processingLabels } from "./message-labels";
import {
  extractReadableText,
  formatJson,
  formatTime,
  formatTimeFull,
} from "./text";

export function MessageDetailDialog({
  message,
  allMessages,
  agentMap,
  taskThreads,
  onClose,
}: {
  message: MessageRecord | null;
  allMessages: MessageRecord[];
  agentMap: Map<string, ConsoleMember>;
  taskThreads: ConsoleTaskThread[];
  onClose: () => void;
}) {
  if (!message) return null;

  const fromMember = agentMap.get(message.fromAgentId);
  const toMember = message.toAgentId ? agentMap.get(message.toAgentId) : null;

  // Find related messages by correlationId
  const related = message.correlationId
    ? allMessages.filter(
        (m) => m.correlationId === message.correlationId && m.id !== message.id,
      )
    : [];

  // Find matching task thread
  const thread =
    taskThreads.find(
      (t) =>
        t.hostMessage.messageId === message.id ||
        t.workerReport?.messageId === message.id,
    ) ??
    taskThreads.find(
      (t) =>
        message.correlationId &&
        t.correlationId === message.correlationId &&
        (t.workerAgentId === message.fromAgentId ||
          t.workerAgentId === message.toAgentId),
    );

  // Build the conversation chain: sort by time
  const chain = [message, ...related].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const text = extractReadableText(message.payload);
  const from = isUserMessage(message)
    ? "你"
    : (fromMember?.displayName ?? message.fromAgentId);
  return (
    <Dialog open onClose={onClose} title="消息详情" width={850}>
      <div className="message-detail">
        <div className="message-detail-heading">
          <strong>{from}</strong>
          <span>→ {toMember?.displayName ?? "全体成员"}</span>
          <Badge>{messageTypeLabels[message.type] ?? message.type}</Badge>
          <time>{formatTimeFull(message.createdAt)}</time>
        </div>
        <article
          className="message-content markdown-body message-detail-content"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(text || "无可读内容"),
          }}
        />
        {thread && (
          <p className="message-thread-status">
            任务：{thread.workerName ?? "—"} /{" "}
            {
              {
                pending: "待处理",
                working: "执行中",
                reported: "已回报，待 Host 验收",
                failed: "执行失败",
              }[thread.status]
            }
          </p>
        )}
        {chain.length > 1 && (
          <details className="message-related">
            <summary>相关消息（{chain.length - 1} 条）</summary>
            {chain
              .filter((item) => item.id !== message.id)
              .map((item) => (
                <section key={item.id}>
                  <p>
                    <strong>
                      {isUserMessage(item)
                        ? "你"
                        : (agentMap.get(item.fromAgentId)?.displayName ??
                          item.fromAgentId)}
                    </strong>{" "}
                    →{" "}
                    {item.toAgentId
                      ? (agentMap.get(item.toAgentId)?.displayName ??
                        item.toAgentId)
                      : "全体成员"}{" "}
                    <time>{formatTime(item.createdAt)}</time>
                  </p>
                  <div
                    className="message-content markdown-body"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(
                        extractReadableText(item.payload) || "无可读内容",
                      ),
                    }}
                  />
                </section>
              ))}
          </details>
        )}
        <details className="message-diagnostics">
          <summary>处理记录与原始数据</summary>
          <dl>
            <dt>处理状态</dt>
            <dd>
              {processingLabels[message.processingStatus] ??
                message.processingStatus}
            </dd>
            <dt>消息 ID</dt>
            <dd>{message.id}</dd>
            <dt>关联 ID</dt>
            <dd>{message.correlationId ?? "无"}</dd>
          </dl>
          <pre>{formatJson(message.payload)}</pre>
        </details>
      </div>
    </Dialog>
  );
}
