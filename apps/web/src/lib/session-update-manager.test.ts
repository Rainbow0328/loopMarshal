import type { LoopMarshalWebSocketClient } from "@loopmarshal/sdk";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionUpdateManager } from "./session-update-manager";

function fixture() {
  const clients: Array<{
    emit: (event: string, payload?: unknown) => void;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const manager = new SessionUpdateManager(queryClient, () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const connection = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      on(event: string, callback: (payload: unknown) => void) {
        handlers.set(event, callback);
        return this;
      },
      emit(event: string, payload?: unknown) {
        handlers.get(event)?.(payload);
      },
    };
    clients.push(connection);
    return connection as unknown as LoopMarshalWebSocketClient;
  });
  return { manager, clients, invalidate };
}

afterEach(() => vi.useRealTimers());

describe("session subscriptions", () => {
  it("shares one socket across panels and closes it only after the final panel unmounts", () => {
    const f = fixture();
    const first = f.manager.subscribe("project-a", vi.fn());
    const listener = vi.fn();
    const second = f.manager.subscribe("project-a", listener);
    expect(f.clients).toHaveLength(1);
    expect(f.clients[0]!.connect).toHaveBeenCalledOnce();
    first();
    expect(f.clients[0]!.disconnect).not.toHaveBeenCalled();
    f.clients[0]!.emit("reconnecting");
    expect(listener).toHaveBeenCalledOnce();
    expect(f.manager.status("project-a")).toBe("reconnecting");
    second();
    expect(f.clients[0]!.disconnect).toHaveBeenCalledOnce();
    expect(f.manager.status("project-a")).toBe("disconnected");
  });

  it("coalesces burst notifications and refreshes knowledge only when knowledge changes", () => {
    vi.useFakeTimers();
    const f = fixture();
    const unsubscribe = f.manager.subscribe("project-a", vi.fn());
    for (let index = 0; index < 40; index++)
      f.clients[0]!.emit("console:update", { reason: "message_sent" });
    vi.advanceTimersByTime(100);
    const keys = f.invalidate.mock.calls.map(([filter]) => filter?.queryKey);
    expect(keys).toHaveLength(6);
    expect(keys).toContainEqual(["messages", "project-a"]);
    expect(keys).not.toContainEqual(["knowledge", "project-a"]);
    f.invalidate.mockClear();
    f.clients[0]!.emit("console:update", { reason: "knowledge_updated" });
    f.clients[0]!.emit("progress:update");
    vi.advanceTimersByTime(100);
    expect(
      f.invalidate.mock.calls.map(([filter]) => filter?.queryKey),
    ).toContainEqual(["knowledge", "project-a"]);
    unsubscribe();
  });

  it("cancels pending refreshes on session exit and ignores late events from the old socket", () => {
    vi.useFakeTimers();
    const f = fixture();
    const unsubscribe = f.manager.subscribe("project-a", vi.fn());
    f.clients[0]!.emit("connected");
    unsubscribe();
    f.clients[0]!.emit("console:update", { reason: "message_sent" });
    f.clients[0]!.emit("connected");
    vi.advanceTimersByTime(1000);
    expect(f.invalidate).not.toHaveBeenCalled();
    const next = f.manager.subscribe("project-b", vi.fn());
    f.clients[1]!.emit("connected");
    vi.advanceTimersByTime(100);
    expect(
      f.invalidate.mock.calls.every(
        ([filter]) => filter?.queryKey?.[1] === "project-b",
      ),
    ).toBe(true);
    next();
  });
});
