import { DiscussionKnowledge } from "./DiscussionKnowledge";
import { mergeDiscussionMessages } from "./discussion-history";
import { getApiClient } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";
import type { DiscussionMessage, DiscussionRoom } from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export function DiscussionConversation({ room }: { room: DiscussionRoom }) {
  const api = getApiClient();
  const qc = useQueryClient();
  const [recipients, setRecipients] = useState(
    room.members.filter((m) => !m.blocked).map((m) => m.id),
  );
  const [content, setContent] = useState("");
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [history, setHistory] = useState<DiscussionMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const activeRecipients = recipients.filter((id) =>
    room.members.some((member) => member.id === id && !member.blocked),
  );
  const list = useRef<HTMLDivElement>(null);
  const messages = useQuery({
    queryKey: ["discussion-messages", room.id],
    queryFn: () => api.listDiscussionMessages(room.id),
    refetchInterval: room.busy ? 1500 : false,
  });
  const all = mergeDiscussionMessages(history, messages.data ?? []);
  useEffect(() => {
    if (messages.data)
      setHistory((current) => mergeDiscussionMessages(current, messages.data!));
  }, [messages.data]);
  const send = useMutation({
    mutationFn: () =>
      api.sendDiscussionMessage(room.id, {
        content,
        memberIds: activeRecipients,
      }),
    onMutate: () => {
      stop.reset();
      qc.setQueryData<DiscussionRoom[]>(["discussions"], (rooms) =>
        rooms?.map((item) =>
          item.id === room.id ? { ...item, busy: true } : item,
        ),
      );
    },
    onSuccess: (data) => {
      qc.setQueryData(["discussion-messages", room.id], data);
      setContent("");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["discussion-messages", room.id] });
      void qc.invalidateQueries({ queryKey: ["discussions"] });
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopDiscussion(room.id) });
  const previous = useMutation({
    mutationFn: () => api.listDiscussionMessages(room.id, all[0]?.id),
    onSuccess: (data) => {
      setHistory((current) => mergeDiscussionMessages(data, current));
      setHasOlder(data.length === 100);
    },
  });
  const busy = room.busy || send.isPending;
  return (
    <>
      <div className="discussion-heading">
        <div>
          <h2>{room.name}</h2>
          <p>{room.members.map((m) => m.name).join(" · ")}</p>
        </div>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => setShowKnowledge(!showKnowledge)}
        >
          {showKnowledge ? "返回讨论" : "讨论知识库"}
        </button>
      </div>
      {showKnowledge ? (
        <DiscussionKnowledge
          room={room}
          messages={all}
          close={() => setShowKnowledge(false)}
        />
      ) : (
        <>
          <div className="discussion-messages" ref={list} aria-live="polite">
            {hasOlder && all.length >= 100 && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={previous.isPending}
                onClick={() => previous.mutate()}
              >
                {previous.isPending ? "正在读取…" : "查看更早的消息"}
              </button>
            )}
            {!all.length && (
              <p className="discussion-empty">提出一个问题，开启讨论。</p>
            )}
            {all.map((message) => (
              <article
                className={`discussion-message ${message.speaker === "用户" ? "is-user" : ""} ${message.status === "failed" ? "is-failed" : ""}`}
                key={message.id}
              >
                <header>
                  <strong>{message.speaker}</strong>
                  <span>
                    {message.status === "pending"
                      ? "思考中"
                      : message.status === "failed"
                        ? "未完成"
                        : new Date(message.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                  </span>
                </header>
                <div
                  className="markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(message.content),
                  }}
                />
              </article>
            ))}
            {(messages.error ?? previous.error) && (
              <p role="alert">{(messages.error ?? previous.error)?.message}</p>
            )}
          </div>
          <div className="discussion-composer">
            <div className="discussion-recipients">
              <span>本轮回复：</span>
              {room.members.map((member) => (
                <label
                  key={member.id}
                  title={
                    member.blocked
                      ? "上轮会话状态不明，请新建讨论室"
                      : member.kind === "cli"
                        ? "接续此讨论室专用的 CLI 会话"
                        : "模型成员"
                  }
                >
                  <input
                    type="checkbox"
                    checked={activeRecipients.includes(member.id)}
                    disabled={busy || member.blocked}
                    onChange={() =>
                      setRecipients((values) =>
                        values.includes(member.id)
                          ? values.filter((id) => id !== member.id)
                          : [...values, member.id],
                      )
                    }
                  />{" "}
                  {member.name}
                  {member.blocked && "（会话异常）"}
                </label>
              ))}
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入问题或继续讨论"
              maxLength={20000}
              disabled={busy}
              onKeyDown={(e) => {
                if (
                  (e.ctrlKey || e.metaKey) &&
                  e.key === "Enter" &&
                  content.trim() &&
                  activeRecipients.length &&
                  !busy
                ) {
                  e.preventDefault();
                  send.mutate();
                }
              }}
            />
            {(send.error ?? stop.error) && (
              <p role="alert">
                {(send.error ?? stop.error)?.message}{" "}
                请先检查消息记录，避免重复发送。
              </p>
            )}
            <div className="discussion-composer-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (list.current)
                    list.current.scrollTop = list.current.scrollHeight;
                }}
              >
                最新消息
              </button>
              {busy ? (
                <button
                  className="btn btn-secondary"
                  disabled={stop.isPending || stop.isSuccess}
                  onClick={() => stop.mutate()}
                >
                  {stop.isSuccess ? "正在停止…" : "停止本轮"}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={!content.trim() || !activeRecipients.length}
                  onClick={() => send.mutate()}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
