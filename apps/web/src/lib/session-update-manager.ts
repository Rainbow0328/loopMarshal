import { LoopMarshalWebSocketClient } from "@loopmarshal/sdk";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { sessionQueryKeys } from "./session-query-keys";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

type Connection = Pick<
  LoopMarshalWebSocketClient,
  "on" | "connect" | "disconnect"
>;
type SessionSubscription = {
  connection: Connection;
  status: ConnectionStatus;
  listeners: Set<() => void>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshKnowledge: boolean;
  disposed: boolean;
};

/** One connection per session and QueryClient, including an embedded activity panel. */
export class SessionUpdateManager {
  private readonly sessions = new Map<string, SessionSubscription>();

  public constructor(
    private readonly queryClient: QueryClient,
    private readonly createConnection: (sessionId: string) => Connection = (
      sessionId,
    ) =>
      new LoopMarshalWebSocketClient({
        baseUrl: window.location.origin,
        agentId: "web-dashboard",
        sessionId,
      }),
  ) {}

  public status(sessionId: string): ConnectionStatus {
    return this.sessions.get(sessionId)?.status ?? "disconnected";
  }

  public subscribe(sessionId: string, listener: () => void): () => void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.create(sessionId);
      this.sessions.set(sessionId, session);
      session.connection.connect();
    }
    const current = session;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      current.disposed = true;
      if (current.refreshTimer !== null) clearTimeout(current.refreshTimer);
      current.connection.disconnect();
      this.sessions.delete(sessionId);
    };
  }

  private create(sessionId: string): SessionSubscription {
    const session: SessionSubscription = {
      connection: this.createConnection(sessionId),
      status: "connecting",
      listeners: new Set(),
      refreshTimer: null,
      refreshKnowledge: false,
      disposed: false,
    };
    const status = (next: ConnectionStatus) => {
      if (session.disposed) return;
      session.status = next;
      for (const listener of session.listeners) listener();
    };
    const refresh = (includeKnowledge = false) => {
      session.refreshKnowledge ||= includeKnowledge;
      if (session.disposed || session.refreshTimer !== null) return;
      // A fixed coalescing window bounds latency even under a continuous event stream.
      session.refreshTimer = setTimeout(() => {
        session.refreshTimer = null;
        const { knowledge, ...queries } = sessionQueryKeys;
        const keys: QueryKey[] = Object.values(queries).map((key) =>
          key(sessionId),
        );
        if (session.refreshKnowledge) keys.push(knowledge(sessionId));
        session.refreshKnowledge = false;
        for (const queryKey of keys) {
          void this.queryClient.invalidateQueries(
            { queryKey },
            { cancelRefetch: false },
          );
        }
      }, 100);
    };
    session.connection
      .on("connected", () => {
        status("connected");
        refresh(true);
      })
      .on("disconnected", () => status("disconnected"))
      .on("reconnecting", () => status("reconnecting"))
      .on("console:update", (message) =>
        refresh(message.reason === "knowledge_updated"),
      )
      .on("inbox:message", () => refresh())
      .on("inbox:claimed", () => refresh())
      .on("progress:update", () => refresh());
    return session;
  }
}
