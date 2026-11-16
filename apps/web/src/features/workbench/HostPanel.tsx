import { DiscussionReference } from "./DiscussionReference";
import { Icon } from "@/components/Icon";
import { EmptyState, ErrorState, pushToast } from "@/components/ui";
import type {
  ConsoleMember,
  MessageRecord,
  WebAgentRuntime,
} from "@loopmarshal/protocol";
import { useEffect, useRef, useState } from "react";
import { memberState } from "./member-state";
import { MessageCard } from "./MessageCard";
import { RuntimeSettingsDialog } from "./RuntimeSettingsDialog";
import {
  useRuntimeCommandMutation,
  useSendHostMessageMutation,
} from "./workbench-queries";

export function HostPanel({
  host,
  hostRuntime,
  messages,
  sessionId,
  models,
  agentMap,
  onManage,
  onOpenDetail,
}: {
  host: ConsoleMember | null;
  hostRuntime: WebAgentRuntime | null;
  messages: MessageRecord[];
  sessionId: string;
  models: Array<{ id: string; name: string; modelId: string }>;
  agentMap: Map<string, ConsoleMember>;
  onManage: () => void;
  onOpenDetail: (m: MessageRecord) => void;
}) {
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showDiscussion, setShowDiscussion] = useState(false);
  const runtimeCommand = useRuntimeCommandMutation(sessionId);
  const sendMessage = useSendHostMessageMutation(sessionId);
  const conversationRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followMessages = useRef(true);
  const [newMessages, setNewMessages] = useState(false);

  const scrollToLatest = (smooth = true) => {
    const node = conversationRef.current;
    if (!node) return;
    node.scrollTo({
      top: node.scrollHeight,
      behavior:
        smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "auto",
    });
    followMessages.current = true;
    setNewMessages(false);
  };

  useEffect(() => {
    setDraft("");
    sendMessage.reset();
    followMessages.current = true;
    scrollToLatest(false);
  }, [sessionId]);

  useEffect(() => {
    if (followMessages.current) scrollToLatest();
    else setNewMessages(true);
  }, [messages.length]);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    }
  }, [draft]);

  const hasHost = Boolean(host);
  const state = host ? memberState(host, hostRuntime) : null;
  const creatingNativeHost =
    host?.route?.accessMode === "managed_proxy" &&
    host.route.bindingStatus === "initializing" &&
    Boolean(
      host.route.binding?.nativeSessionId.startsWith("loopmarshal-pending:"),
    );
  const blocked =
    host?.route?.bindingStatus === "blocked" ||
    host?.route?.bindingStatus === "disabled" ||
    (host?.route?.bindingStatus === "initializing" && !creatingNativeHost) ||
    Boolean(host?.activity?.unknown);
  const waiting =
    !hostRuntime &&
    host?.route?.accessMode !== "managed_proxy" &&
    host?.status === "offline";
  const runtimeStopped =
    hostRuntime && !["running", "idle"].includes(hostRuntime.status);

  const handleSend = () => {
    if (!host || !draft.trim() || blocked || sendMessage.isPending) return;
    const sentDraft = draft;
    sendMessage.mutate(
      { hostAgentId: host.agentId, content: draft.trim() },
      {
        onSuccess: () => {
          setDraft((current) => (current === sentDraft ? "" : current));
          scrollToLatest();
        },
        onError: (e) => pushToast(e.message, "error"),
      },
    );
  };

  return (
    <>
      <section className="host-panel">
        {(blocked ||
          waiting ||
          runtimeStopped ||
          host?.route?.lastError ||
          host?.activity?.lastFailure) && (
          <div
            className={`host-readiness ${blocked ? "needs-attention" : ""}`}
            role="status"
          >
            <Icon name="info" size={17} />
            <div>
              <strong>{state?.label}</strong>
              <p>
                {host?.route?.lastError ??
                  host?.activity?.lastFailure ??
                  (blocked
                    ? "请在顶部“查看绑定”中检查连接；执行中断后，请先核对该工具里的任务结果。"
                    : waiting
                      ? "可以先发送消息，消息将进入 Host 收件箱；请让外部工具接入并领取。"
                      : "消息可进入收件箱，启动 Host 后才会继续处理。")}
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={hostRuntime ? () => setShowSettings(true) : onManage}
            >
              查看配置
            </button>
          </div>
        )}
        {runtimeCommand.error && (
          <ErrorState message={runtimeCommand.error.message} />
        )}
        <div className="conversation-surface">
          <div
            className="host-conversation"
            ref={conversationRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              followMessages.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 96;
              if (followMessages.current) setNewMessages(false);
            }}
            role="log"
            aria-label="Host 对话记录"
          >
            {!hasHost ? (
              <EmptyState
                title="暂无 Host"
                desc="新建协作时请选择主控模型或编程工具。"
              />
            ) : (
              <div className="conversation-thread">
                {messages.map((message) => (
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
                        : undefined
                    }
                    onOpenDetail={() => onOpenDetail(message)}
                  />
                ))}
              </div>
            )}
          </div>
          {newMessages && (
            <button
              className="latest-messages"
              onClick={() => scrollToLatest()}
            >
              <Icon name="arrow" size={14} />
              查看新消息
            </button>
          )}
        </div>
        {hasHost && (
          <div className="composer-wrap">
            <div className="composer">
              <textarea
                ref={inputRef}
                className="composer-input"
                aria-label="发送给 Host 的消息"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    if (!sendMessage.isPending) handleSend();
                  }
                }}
              />
              <div className="composer-bottom">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowDiscussion(true)}
                  type="button"
                >
                  引用讨论知识
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!draft.trim() || sendMessage.isPending || blocked}
                  onClick={handleSend}
                >
                  <Icon name="send" size={14} />
                  {sendMessage.isPending ? "发送中…" : "发送"}
                </button>
              </div>
            </div>
            <div className="composer-hint">
              <span>Enter 发送，Shift + Enter 换行</span>
              <span>AI 的执行结果仍需核实</span>
            </div>
            {sendMessage.error && (
              <p className="composer-error" role="alert">
                {sendMessage.error.message}。内容已保留，可重试发送。
              </p>
            )}
          </div>
        )}
      </section>

      <DiscussionReference
        sessionId={sessionId}
        open={showDiscussion}
        close={() => setShowDiscussion(false)}
        insert={(text) =>
          setDraft((current) => (current ? `${current}\n\n${text}` : text))
        }
      />
      <RuntimeSettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        runtime={hostRuntime}
        models={models}
        sessionId={sessionId}
      />
    </>
  );
}
