import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/ui";
import type { ConsoleMember, MessageRecord } from "@loopmarshal/protocol";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { messageTypeLabels, processingLabels } from "./message-labels";
import { MessageCard } from "./MessageCard";
import { extractReadableText } from "./text";

export function MessageBrowser({
  messages,
  members,
  agentMap,
  memberId,
  onMemberChange,
  onOpenDetail,
}: {
  messages: MessageRecord[];
  members: ConsoleMember[];
  agentMap: Map<string, ConsoleMember>;
  memberId: string;
  onMemberChange: (id: string) => void;
  onOpenDetail: (message: MessageRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const searchIndex = useMemo(
    () =>
      new Map(
        messages.map((message) => [
          message.id,
          `${extractReadableText(message.payload)} ${agentMap.get(message.fromAgentId)?.displayName ?? ""} ${message.toAgentId ? (agentMap.get(message.toAgentId)?.displayName ?? "") : ""}`.toLocaleLowerCase(),
        ]),
      ),
    [messages, agentMap],
  );
  useEffect(() => setVisibleCount(100), [search, memberId, type, status]);
  const filtered = useMemo(
    () =>
      messages
        .filter((message) => {
          if (
            memberId &&
            message.fromAgentId !== memberId &&
            message.toAgentId !== memberId &&
            message.toAgentId
          )
            return false;
          if (type && message.type !== type) return false;
          if (status && message.processingStatus !== status) return false;
          return !search || searchIndex.get(message.id)?.includes(search);
        })
        .reverse(),
    [messages, memberId, type, status, search, searchIndex],
  );
  // Browsing history never follows incoming messages or scrolls the enclosing dialog.
  return (
    <div className="message-browser">
      <div className="message-browser-filters">
        <label className="message-search">
          <Icon name="search" size={17} />
          <input
            className="input"
            aria-label="搜索会话消息"
            placeholder="搜索消息内容或成员"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          className="input"
          aria-label="按成员筛选消息"
          value={memberId}
          onChange={(event) => onMemberChange(event.target.value)}
        >
          <option value="">全部成员</option>
          {members.map((member) => (
            <option key={member.agentId} value={member.agentId}>
              {member.displayName}
              {member.role === "host" ? "（Host）" : ""}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="按消息类型筛选"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">全部类型</option>
          {Object.entries(messageTypeLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="按处理状态筛选"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(processingLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p className="message-browser-count">
        {filtered.length} 条消息 · 最新在前
      </p>
      <div className="message-browser-list">
        {filtered.length ? (
          filtered
            .slice(0, visibleCount)
            .map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                role={agentMap.get(message.fromAgentId)?.role ?? "unknown"}
                fromName={
                  agentMap.get(message.fromAgentId)?.displayName ??
                  message.fromAgentId
                }
                toName={
                  message.toAgentId
                    ? agentMap.get(message.toAgentId)?.displayName
                    : "全体成员"
                }
                onOpenDetail={() => onOpenDetail(message)}
              />
            ))
        ) : (
          <EmptyState
            title="没有匹配的消息"
            desc="试试其他关键词或筛选条件。"
          />
        )}
      </div>
      {filtered.length > visibleCount && (
        <button
          className="btn btn-secondary"
          onClick={() => setVisibleCount((count) => count + 100)}
        >
          加载更多消息（剩余 {filtered.length - visibleCount} 条）
        </button>
      )}
    </div>
  );
}
