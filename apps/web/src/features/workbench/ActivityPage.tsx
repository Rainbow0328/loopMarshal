import { useSearch } from "@tanstack/react-router";
import { ErrorState, pushToast } from "@/components/ui";
import { SessionActivity } from "./SessionActivity";

export function ActivityPage() {
  const { sessionId, memberId } = useSearch({ from: "/activity" });
  const history = async () => {
    if (!sessionId) return;
    if (window.loopmarshalDesktop?.openConversationHistory) {
      try {
        if (sessionId)
          await window.loopmarshalDesktop.openConversationHistory(
            sessionId,
            memberId,
          );
      } catch {
        pushToast("无法打开历史记录，请返回主窗口查看会话消息", "error");
      }
    } else
      window.location.assign(
        `/?${new URLSearchParams({ sessionId, view: "messages", ...(memberId ? { memberId } : {}) })}`,
      );
  };
  return sessionId ? (
    <SessionActivity
      key={`${sessionId}:${memberId ?? ""}`}
      sessionId={sessionId}
      memberId={memberId}
      standalone
      onHistory={() => void history()}
    />
  ) : (
    <ErrorState message="未选择观察的会话，请从当前协作打开运行观察。" />
  );
}
