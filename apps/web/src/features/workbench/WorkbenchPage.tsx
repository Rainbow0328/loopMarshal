import { Icon } from "@/components/Icon";
import { Dialog, ErrorState, Loading, pushToast } from "@/components/ui";
import { useSelectedSession } from "@/lib/selected-session";
import { useSessionUpdates } from "@/lib/session-updates";
import type { ConsoleTaskThread, MessageRecord } from "@loopmarshal/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { userHostConversation } from "./conversation";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { DiscoverSessionsDialog } from "./DiscoverSessionsDialog";
import { HostPanel } from "./HostPanel";
import { MemberRoutesPanel } from "./MemberRoutesPanel";
import { MembersPanel } from "./MembersPanel";
import { MessageBrowser } from "./MessageBrowser";
import { MessageDetailDialog } from "./MessageDetailDialog";
import { SessionActivity } from "./SessionActivity";
import { SessionOverview } from "./SessionOverview";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  getRuntimeForAgent,
  getSelectedSessionId,
  invalidateSession,
  useConsoleQuery,
  useInsightQuery,
  useMessagesQuery,
  useModelsQuery,
  useRuntimesQuery,
  useSessionsQuery,
} from "./workbench-queries";
import { WorkspaceWelcome } from "./WorkspaceWelcome";

export function WorkbenchPage() {
  const search = useSearch({ from: "/" });
  const appliedHistory = useRef("");
  const qc = useQueryClient();
  const sessionsQuery = useSessionsQuery();
  const modelsQuery = useModelsQuery();
  const [explicitSessionId, setExplicitSessionId] = useSelectedSession();
  const [showMessages, setShowMessages] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [messageMemberId, setMessageMemberId] = useState("");
  const [detailMessage, setDetailMessage] = useState<MessageRecord | null>(
    null,
  );
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDiscoverDialog, setShowDiscoverDialog] = useState(false);

  const sessions = sessionsQuery.data ?? [];
  const sessionId = getSelectedSessionId(sessions, explicitSessionId);
  const consoleQuery = useConsoleQuery(sessionId);
  const messagesQuery = useMessagesQuery(sessionId);
  const runtimesQuery = useRuntimesQuery(sessionId);
  const insightQuery = useInsightQuery(sessionId, showProgress);

  useSessionUpdates(sessionId);

  const consoleData = consoleQuery.data ?? null;
  const messages = useMemo(
    () =>
      [...(messagesQuery.data ?? [])].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    [messagesQuery.data],
  );
  const runtimes = runtimesQuery.data ?? [];
  const models = modelsQuery.data ?? [];

  const members = consoleData?.members ?? [];
  const host = members.find((m) => m.role === "host") ?? null;
  const hostRuntime = getRuntimeForAgent(runtimes, host?.agentId);
  const taskThreads = consoleData?.taskThreads ?? [];

  useEffect(() => {
    setMessageMemberId("");
    setShowMessages(false);
    setShowMembers(false);
    setShowActivity(false);
    setShowProgress(false);
    setShowRoutes(false);
    setDetailMessage(null);
  }, [sessionId]);

  useEffect(() => {
    if (
      !search.sessionId ||
      !sessions.some((session) => session.id === search.sessionId)
    )
      return;
    const key = `${search.sessionId}:${search.view ?? ""}:${search.memberId ?? ""}`;
    if (appliedHistory.current === key) return;
    if (sessionId !== search.sessionId) {
      setExplicitSessionId(search.sessionId);
      return;
    }
    appliedHistory.current = key;
    if (search.view === "messages") {
      setMessageMemberId(search.memberId ?? "");
      setShowMessages(true);
    }
  }, [
    search.sessionId,
    search.view,
    search.memberId,
    sessionId,
    sessions,
    setExplicitSessionId,
  ]);

  useEffect(() => {
    if (!showActivity) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowActivity(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [showActivity]);

  const agentMap = useMemo(
    () => new Map(members.map((m) => [m.agentId, m])),
    [members],
  );

  const hostMessages = useMemo(
    () => userHostConversation(messages, host?.agentId),
    [messages, host?.agentId],
  );
  const loading =
    sessionsQuery.isLoading ||
    consoleQuery.isLoading ||
    messagesQuery.isLoading;

  const error =
    sessionsQuery.error ?? consoleQuery.error ?? messagesQuery.error;
  const openTask = (thread: ConsoleTaskThread) => {
    const message = messages.find(
      (item) => item.id === thread.hostMessage.messageId,
    );
    if (message) setDetailMessage(message);
    else {
      pushToast("正在读取原任务，请稍后重试", "info");
      void messagesQuery.refetch();
    }
  };
  const overview = consoleData && (
    <SessionOverview
      data={consoleData}
      insight={insightQuery.data ?? null}
      loading={insightQuery.isLoading}
      error={insightQuery.error}
      runtimes={runtimes}
      onSelectMember={() => {
        setShowProgress(false);
        setShowMembers(true);
      }}
      onOpenTask={openTask}
      onManage={() => {
        setShowProgress(false);
        setShowRoutes(true);
      }}
      onRetry={() => {
        void insightQuery.refetch();
      }}
    />
  );
  return (
    <>
      <header className="session-toolbar workbench-header">
        <div className="workbench-heading">
          <h1 className="sr-only">{consoleData?.session.name ?? "当前协作"}</h1>
          <SessionSwitcher
            sessions={sessions}
            sessionId={sessionId}
            onSelect={setExplicitSessionId}
            onRefresh={() => {
              void sessionsQuery.refetch();
            }}
            refreshing={sessionsQuery.isFetching}
            onDiscover={() => setShowDiscoverDialog(true)}
          />
        </div>
        <div
          className="session-toolbar-end"
          role="toolbar"
          aria-label="协作操作"
        >
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowCreateDialog(true)}
          >
            <Icon name="plus" size={15} />
            新建协作
          </button>
          {sessionId && (
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowMembers(true)}
              >
                <Icon name="people" size={15} />
                成员 ({members.length})
              </button>
              <MemberRoutesPanel
                key={sessionId}
                sessionId={sessionId}
                opened={showRoutes}
                onOpenedChange={setShowRoutes}
              />
              <button
                className="btn btn-secondary btn-sm progress-trigger"
                onClick={() => setShowProgress(true)}
              >
                <Icon name="activity" size={15} />
                进展
              </button>
              <button
                className={`btn btn-secondary btn-sm activity-trigger ${showActivity ? "is-active" : ""}`}
                aria-expanded={showActivity}
                onClick={() => setShowActivity((value) => !value)}
              >
                <span className="activity-indicator is-connected" />
                实时动态
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setMessageMemberId("");
                  setShowMessages(true);
                }}
              >
                <Icon name="search" size={15} />
                对话历史
              </button>
            </>
          )}
        </div>
      </header>
      {error && (
        <div className="workbench-error">
          <ErrorState
            message={error.message}
            onRetry={() => {
              void sessionsQuery.refetch();
              invalidateSession(qc, sessionId);
            }}
          />
        </div>
      )}
      {loading && !consoleData ? (
        <Loading text="正在加载工作台数据…" />
      ) : !sessionId || !consoleData ? (
        <WorkspaceWelcome
          onCreate={() => setShowCreateDialog(true)}
          onDiscover={() => setShowDiscoverDialog(true)}
        />
      ) : (
        <div
          className={`workbench-layout conversation-workspace ${showActivity ? "has-activity" : ""}`}
        >
          <HostPanel
            key={sessionId}
            host={host}
            hostRuntime={hostRuntime}
            messages={hostMessages}
            sessionId={sessionId}
            models={models}
            agentMap={agentMap}
            onManage={() => setShowRoutes(true)}
            onOpenDetail={setDetailMessage}
          />
          {showActivity && (
            <SessionActivity
              key={sessionId}
              sessionId={sessionId}
              onClose={() => setShowActivity(false)}
              onHistory={() => {
                setMessageMemberId("");
                setShowMessages(true);
              }}
            />
          )}
        </div>
      )}

      <Dialog
        open={showProgress && Boolean(sessionId)}
        onClose={() => setShowProgress(false)}
        title="会话进展"
        width={650}
      >
        {overview}
      </Dialog>
      <Dialog
        open={showMembers && Boolean(sessionId)}
        onClose={() => setShowMembers(false)}
        title="会话成员"
        width={850}
      >
        {sessionId && (
          <MembersPanel
            members={members}
            runtimes={runtimes}
            models={models}
            sessionId={sessionId}
            onMessages={(id) => {
              setShowMembers(false);
              setMessageMemberId(id);
              setShowMessages(true);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={showMessages && Boolean(sessionId)}
        onClose={() => setShowMessages(false)}
        title="会话消息"
        width={960}
      >
        {showMessages && (
          <MessageBrowser
            key={sessionId}
            messages={messages}
            members={members}
            agentMap={agentMap}
            memberId={messageMemberId}
            onMemberChange={setMessageMemberId}
            onOpenDetail={setDetailMessage}
          />
        )}
      </Dialog>

      {/* Message Detail Dialog */}
      <MessageDetailDialog
        message={detailMessage}
        allMessages={messages}
        agentMap={agentMap}
        taskThreads={taskThreads}
        onClose={() => setDetailMessage(null)}
      />

      <CreateSessionDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        models={models}
        onCreated={(sid) => setExplicitSessionId(sid)}
      />
      <DiscoverSessionsDialog
        open={showDiscoverDialog}
        onClose={() => setShowDiscoverDialog(false)}
        onSelect={setExplicitSessionId}
      />
    </>
  );
}
