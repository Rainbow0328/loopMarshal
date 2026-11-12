import { LoopMarshalWebSocketClient } from "@loopmarshal/sdk";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("does not reconnect or keep a heartbeat alive after a view has closed", () => {
  vi.useFakeTimers();
  const sockets: TestSocket[] = [];
  class TestSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage = null;
    onerror = null;
    constructor() {
      sockets.push(this);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    send = vi.fn();
  }
  vi.stubGlobal("WebSocket", TestSocket);
  const client = new LoopMarshalWebSocketClient({
    baseUrl: "http://localhost",
    agentId: "viewer",
    sessionId: "a",
  });
  const reconnecting = vi.fn();
  client.on("reconnecting", reconnecting);
  client.connect();
  sockets[0]!.onopen?.();
  sockets[0]!.close();
  client.disconnect();
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(reconnecting).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
