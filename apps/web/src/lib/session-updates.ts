import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import {
  SessionUpdateManager,
  type ConnectionStatus,
} from "./session-update-manager";

const managers = new WeakMap<QueryClient, SessionUpdateManager>();

export function useSessionUpdates(
  sessionId: string | null | undefined,
): ConnectionStatus {
  const queryClient = useQueryClient();
  let manager = managers.get(queryClient);
  if (!manager) {
    manager = new SessionUpdateManager(queryClient);
    managers.set(queryClient, manager);
  }
  const current = manager;
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? current.subscribe(sessionId, listener) : () => {},
    [current, sessionId],
  );
  const snapshot = useCallback(
    () => (sessionId ? current.status(sessionId) : ("disconnected" as const)),
    [current, sessionId],
  );
  return useSyncExternalStore(subscribe, snapshot, () => "disconnected");
}
