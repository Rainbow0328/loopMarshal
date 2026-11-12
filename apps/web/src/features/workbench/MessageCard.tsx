import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui";
import { renderMarkdown } from "@/lib/markdown";
import type { MessageRecord } from "@loopmarshal/protocol";
import { useMemo } from "react";
import { messageTypeLabels } from "./message-labels";
import { extractReadableText, formatTime, formatTimeFull } from "./text";

export function MessageCard({
  message,
  role,
  fromName,
  toName,
  onOpenDetail,
}: {
  message: MessageRecord;
  role: string;
  fromName?: string;
  toName?: string;
  onOpenDetail: () => void;
}) {
  const isError =
    message.type === "error" || message.processingStatus === "failed";
  const text = extractReadableText(message.payload);
  const isUser =
    typeof message.payload === "object" &&
    message.payload !== null &&
    "kind" in message.payload &&
    message.payload.kind === "web_user_message";
  // A list preview is one readable paragraph; the detail view keeps all blocks.
  const shown = useMemo(
    () =>
      text
        .replace(
          /```[^\n]*\n([\s\S]*?)(?:```|$)/g,
          (_match, code: string) =>
            `\`${code.trim().replace(/\s+/g, " ").replace(/`/g, "")}\``,
        )
        .split(/\r?\n/)
        .map((line) =>
          line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, "").trim(),
        )
        .filter((line) => line && !/^[-|: ]+$/.test(line))
        .join(" ")
        .slice(0, 360),
    [text],
  );
  const html = useMemo(() => renderMarkdown(shown || "无可读内容"), [shown]);
  return (
    <div
      data-message-id={message.id}
      className={`conversation-message ${isUser ? "is-user" : "is-agent"} ${isError ? "is-error" : ""}`}
    >
      <span
        className={`message-avatar ${isUser ? "avatar-user" : `avatar-${role}`}`}
      >
        {isUser ? (
          "你"
        ) : (
          <Icon
            name={
              role === "knowledge_keeper"
                ? "book"
                : role === "host"
                  ? "workspace"
                  : "terminal"
            }
            size={17}
          />
        )}
      </span>
      <div className="message-main">
        <div className="message-meta">
          <strong>
            {isUser
              ? "你"
              : (fromName ??
                (role === "host"
                  ? "Host"
                  : role === "knowledge_keeper"
                    ? "知识库维护者"
                    : "Worker"))}
          </strong>
          {!isUser && toName && message.fromAgentId !== message.toAgentId && (
            <span className="message-recipient">→ {toName}</span>
          )}
          {!isUser && (
            <Badge variant={isError ? "error" : "neutral"}>
              {messageTypeLabels[message.type] ?? message.type}
            </Badge>
          )}
          {isUser && (
            <span
              className={`message-receipt receipt-${message.processingStatus}`}
            >
              {message.processingStatus === "processed"
                ? "已处理"
                : message.processingStatus === "claimed"
                  ? "Host 处理中"
                  : message.processingStatus === "failed"
                    ? "处理失败"
                    : "等待 Host 接收"}
            </span>
          )}
          <time title={formatTimeFull(message.createdAt)}>
            {formatTime(message.createdAt)}
          </time>
          <button
            className="btn-link"
            onClick={onOpenDetail}
            title="查看消息详情"
          >
            详情
          </button>
        </div>
        <div className="message-bubble">
          <div
            className="message-content markdown-body message-preview"
            dangerouslySetInnerHTML={{
              __html: html,
            }}
          />
        </div>
      </div>
    </div>
  );
}
