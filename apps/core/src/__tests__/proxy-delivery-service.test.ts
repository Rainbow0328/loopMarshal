import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyFixture } from "./proxy-fixture.js";
import { ProxyDeliveryService } from "../services/proxy-delivery-service.js";
import type {
  NativeSessionAdapter,
  NativeTurnResult,
} from "../services/native-session-adapters.js";
import { ProxyProcessError } from "../services/proxy-process.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
});
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a durable delivery transition.");
}
function fixture(
  result: NativeTurnResult | Error = {
    outcome: "reported",
    text: "Frontend result",
    nativeSessionId: "native-123",
    exitCode: 0,
  },
) {
  const f = createProxyFixture();
  cleanup.push(f.close);
  const calls: string[] = [];
  const adapter: NativeSessionAdapter = {
    verify: async () => ({
      version: "fixture-1",
      evidence: "Existing ID and cwd",
    }),
    execute: async (snapshot, prompt) => {
      calls.push(`${snapshot.binding.nativeSessionId}:${prompt}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const service = new ProxyDeliveryService(
    f.database,
    f.deliveries,
    f.routes,
    f.messages,
    () => {},
    adapter,
  );
  cleanup.push(() => service.stop());
  return { ...f, calls, adapter, service };
}

describe("proxy execution and result lifecycle", () => {
  it("continues queued work in the same native session without waiting for another scheduler interval", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    f.send("First task");
    f.send("Continue after the first task");
    vi.useFakeTimers();
    try {
      f.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(2);
      expect(
        f.deliveries
          .list(f.session.id)
          .every((delivery) => delivery.state === "completed"),
      ).toBe(true);
    } finally {
      await f.service.stop();
      vi.useRealTimers();
    }
  });
  it("creates a native Host session on the first workbench message, then resumes its recorded ID", async () => {
    const f = createProxyFixture();
    cleanup.push(f.close);
    const current = f.routeService.get(f.session.id, f.host.id).route;
    const pending = f.routeService.update(f.session.id, f.host.id, {
      accessMode: "managed_proxy",
      expectedBindingVersion: current.bindingVersion,
      reason: "Create a new Host conversation on first message",
      binding: {
        installationId: f.proxy.installation!.id,
        workspacePath: f.directory,
        runtimeNamespace: f.directory,
      },
    });
    expect(pending.route.bindingStatus).toBe("initializing");
    const calls: string[] = [];
    const adapter: NativeSessionAdapter = {
      verify: async () => ({
        version: "fixture-1",
        evidence: "Exact created session ID and cwd",
      }),
      create: async (_snapshot, prompt) => {
        calls.push(`create:${prompt}`);
        return {
          nativeSessionId: "created-native-host",
          version: "fixture-1",
          result: {
            outcome: "reported",
            text: "Host opened a new conversation",
            nativeSessionId: "created-native-host",
            exitCode: 0,
          },
        };
      },
      execute: async (snapshot, prompt) => {
        calls.push(`resume:${snapshot.binding.nativeSessionId}:${prompt}`);
        return {
          outcome: "reported",
          text: "Host continued its conversation",
          nativeSessionId: snapshot.binding.nativeSessionId,
          exitCode: 0,
        };
      },
    };
    const service = new ProxyDeliveryService(
      f.database,
      f.deliveries,
      f.routes,
      f.messages,
      () => {},
      adapter,
      undefined,
      (sessionId, agentId, expectedVersion, nativeSessionId, version) =>
        f.routeService.bindCreatedNativeSession(
          sessionId,
          agentId,
          expectedVersion,
          nativeSessionId,
          version,
        ),
    );
    cleanup.push(() => service.stop());
    const sendFromWorkbench = (content: string, key: string) =>
      f.messageService.sendMessage({
        sessionId: f.session.id,
        fromAgentId: f.host.id,
        toAgentId: f.host.id,
        type: "instruction",
        idempotencyKey: key,
        payload: { kind: "web_user_message", content },
      });
    const first = sendFromWorkbench(
      "Start my new Host conversation",
      "host-first-message",
    );
    const second = sendFromWorkbench(
      "Queue behind the first Host message",
      "host-second-message",
    );
    service.start();
    await until(() => {
      const state = f.deliveries
        .list(f.session.id)
        .find((delivery) => delivery.messageId === first.id)?.state;
      return ["completed", "failed", "blocked", "unknown"].includes(
        state ?? "",
      );
    });
    const firstDelivery = f.deliveries
      .list(f.session.id)
      .find((delivery) => delivery.messageId === first.id)!;
    expect(
      firstDelivery.state,
      firstDelivery.error ?? "First Host message failed",
    ).toBe("completed");
    expect(calls[0]).toContain("create:");
    expect(
      f.routeService.get(f.session.id, f.host.id).route.binding,
    ).toMatchObject({ nativeSessionId: "created-native-host" });
    const firstReport = f.messages.findById(firstDelivery.resultMessageId!);
    expect(firstReport).toMatchObject({
      fromAgentId: f.host.id,
      toAgentId: f.host.id,
      processingStatus: "processed",
      payload: {
        kind: "host_reply",
        content: "Host opened a new conversation",
        inReplyToMessageId: first.id,
      },
    });

    await until(() => {
      const state = f.deliveries
        .list(f.session.id)
        .find((delivery) => delivery.messageId === second.id)?.state;
      return ["completed", "failed", "blocked", "unknown"].includes(
        state ?? "",
      );
    });
    const secondDelivery = f.deliveries
      .list(f.session.id)
      .find((delivery) => delivery.messageId === second.id)!;
    expect(
      secondDelivery.state,
      secondDelivery.error ?? "Second Host message failed",
    ).toBe("completed");
    expect(calls[1]).toContain("resume:created-native-host:");
    expect(secondDelivery.snapshot.binding.nativeSessionId).toBe(
      "created-native-host",
    );
  });

  it("creates and records a native session on the first task when no session existed", async () => {
    const f = createProxyFixture();
    cleanup.push(f.close);
    const pending = f.routeService.createProxyMember(f.session.id, {
      agentName: "新会话开发",
      roleDescription: "Frontend",
      binding: {
        installationId: f.proxy.installation!.id,
        workspacePath: f.directory,
        runtimeNamespace: f.directory,
      },
    });
    expect(pending.route.bindingStatus).toBe("initializing");
    const calls: string[] = [];
    const adapter: NativeSessionAdapter = {
      verify: async () => ({
        version: "fixture-1",
        evidence: "Created ID and cwd",
      }),
      create: async (snapshot, prompt) => {
        calls.push(`${snapshot.binding.nativeSessionId}:${prompt}`);
        return {
          nativeSessionId: "created-native-456",
          version: "fixture-1",
          result: {
            outcome: "reported",
            text: "created result",
            nativeSessionId: "created-native-456",
            exitCode: 0,
          },
        };
      },
      execute: async () => {
        throw new Error("must use create on first task");
      },
    };
    const service = new ProxyDeliveryService(
      f.database,
      f.deliveries,
      f.routes,
      f.messages,
      () => {},
      adapter,
      undefined,
      (sessionId, agentId, expectedVersion, nativeSessionId, version) =>
        f.routeService.bindCreatedNativeSession(
          sessionId,
          agentId,
          expectedVersion,
          nativeSessionId,
          version,
        ),
    );
    cleanup.push(() => service.stop());
    const message = f.messageService.sendMessage({
      sessionId: f.session.id,
      fromAgentId: f.host.id,
      toAgentId: pending.agent.id,
      type: "task",
      payload: "first task",
    });
    service.start();
    await until(() => {
      const state = f.deliveries
        .list(f.session.id)
        .find((delivery) => delivery.messageId === message.id)?.state;
      return ["completed", "failed", "blocked", "unknown"].includes(
        state ?? "",
      );
    });
    const delivery = f.deliveries
      .list(f.session.id)
      .find((item) => item.messageId === message.id)!;
    expect(delivery.state, delivery.error ?? "New worker session failed").toBe(
      "completed",
    );
    expect(calls[0]).toContain("first task");
    expect(
      f.routeService.get(f.session.id, pending.agent.id).route,
    ).toMatchObject({
      bindingStatus: "ready",
      binding: { nativeSessionId: "created-native-456" },
    });
  });

  it("resumes a native Host for a worker result once without sending the final reply back into execution", async () => {
    const f = fixture();
    const hostRoute = f.routeService.get(f.session.id, f.host.id).route;
    f.routeService.update(f.session.id, f.host.id, {
      accessMode: "managed_proxy",
      expectedBindingVersion: hostRoute.bindingVersion,
      reason: "Use existing native Host conversation",
      binding: {
        installationId: f.proxy.installation!.id,
        workspacePath: f.directory,
        runtimeNamespace: f.directory,
        nativeSessionId: "native-host",
      },
    });
    f.adapter.execute = async (snapshot, prompt) => {
      f.calls.push(prompt);
      return {
        outcome: "reported",
        text: "HOST_REVIEWED",
        nativeSessionId: snapshot.binding.nativeSessionId,
        exitCode: 0,
      };
    };
    await f.service.verify(f.session.id, f.host.id, 2);
    const report = f.messageService.sendMessage({
      sessionId: f.session.id,
      fromAgentId: f.proxy.agent.id,
      toAgentId: f.host.id,
      type: "result",
      payload: "WORKER_DONE",
    });
    f.service.start();
    await until(() =>
      f.deliveries
        .list(f.session.id)
        .some((d) => d.messageId === report.id && d.state === "completed"),
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain("WORKER_DONE");
    expect(f.deliveries.list(f.session.id)).toHaveLength(1);
    expect(f.messages.findById(report.id)?.processingStatus).toBe("processed");
    const messages = f.messages.listBySessionId(f.session.id);
    const clientUpdates = messages.filter(
      (message) =>
        typeof message.payload === "object" &&
        message.payload !== null &&
        "kind" in message.payload &&
        message.payload.kind === "host_reply",
    );
    expect(clientUpdates).toHaveLength(1);
    expect(clientUpdates[0]).toMatchObject({
      fromAgentId: f.host.id,
      toAgentId: f.host.id,
      processingStatus: "processed",
      payload: { content: "HOST_REVIEWED", inReplyTo: report.id },
    });
    const delivery = f.deliveries.list(f.session.id)[0]!;
    expect(f.messages.findById(delivery.resultMessageId!)).toMatchObject({
      fromAgentId: f.host.id,
      toAgentId: f.proxy.agent.id,
      payload: { kind: "proxy_report.v1", content: "HOST_REVIEWED" },
    });
  });
  it("continues the fixed native session and atomically directs its result to the original host", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    const message = f.send();
    f.service.start();
    await until(
      () => f.deliveries.list(f.session.id)[0]?.state === "completed",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain("native-123:");
    expect(f.messages.findById(message.id)?.processingStatus).toBe("processed");
    const report = f.messageService.claimNext(f.host.id, { types: ["result"] });
    expect(report).toMatchObject({
      fromAgentId: f.proxy.agent.id,
      toAgentId: f.host.id,
      correlationId: "task-thread-1",
      payload: {
        status: "ready_for_review",
        inReplyToMessageId: message.id,
        nativeSessionId: "native-123",
        result: "Frontend result",
      },
    });
    expect(f.deliveries.list(f.session.id)[0]?.resultMessageId).toBe(
      report?.id,
    );
    expect(() =>
      f.messageService.completeMessage(message.id, f.proxy.agent.id),
    ).toThrow(/executor/);
  });

  it("persists worker failures as a directed report instead of leaving the host waiting", async () => {
    const f = fixture({
      outcome: "failed",
      text: "Tool failed",
      nativeSessionId: "native-123",
      exitCode: 1,
    });
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    const message = f.send();
    f.service.start();
    await until(() => f.deliveries.list(f.session.id)[0]?.state === "failed");
    expect(f.messages.findById(message.id)?.processingStatus).toBe("failed");
    expect(
      f.messageService.claimNext(f.host.id, { types: ["result"] })?.payload,
    ).toMatchObject({ status: "failed" });
  });

  it("requires review for an identity mismatch and does not mark the original task completed", async () => {
    const f = fixture({
      outcome: "reported",
      text: "wrong session",
      nativeSessionId: "native-456",
      exitCode: 0,
    });
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    const message = f.send();
    f.service.start();
    await until(() => f.deliveries.list(f.session.id)[0]?.state === "unknown");
    expect(f.messages.findById(message.id)?.processingStatus).toBe("claimed");
    const delivery = f.deliveries.list(f.session.id)[0]!;
    expect(() =>
      f.service.resolveUnknown(delivery.id, {
        outcome: "failed",
        summary: "review",
        confirmedStopped: false,
      }),
    ).toThrow(/Confirm/);
    f.service.resolveUnknown(delivery.id, {
      outcome: "failed",
      summary: "Native process stopped; files reviewed",
      confirmedStopped: true,
    });
    expect(f.deliveries.get(delivery.id)?.state).toBe("failed");
    expect(f.calls).toHaveLength(1);
  });

  it("keeps a pre-spawn failure recoverable and cancelable without repeating side effects", async () => {
    const f = fixture(new ProxyProcessError("Executable unavailable", false));
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    const message = f.send();
    f.service.start();
    await until(() => f.deliveries.list(f.session.id)[0]?.state === "blocked");
    expect(f.messages.findById(message.id)?.processingStatus).toBe("pending");
    expect(f.deliveries.list(f.session.id)[0]?.attemptId).toBeNull();
    await f.service.cancel(f.deliveries.list(f.session.id)[0]!.id);
    expect(f.messages.findById(message.id)?.processingStatus).toBe("failed");
    expect(f.deliveries.list(f.session.id)[0]?.state).toBe("cancelled");
  });

  it("recovers interrupted deliveries as unknown without invoking the adapter", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    f.send();
    const old = f.deliveries.claim("old-core")!;
    f.service.start();
    expect(f.deliveries.get(old.id)?.state).toBe("unknown");
    expect(f.calls).toHaveLength(0);
    expect(() => f.sessionService.leaveSession(f.proxy.agent.id)).toThrow(
      /Resolve or cancel/,
    );
  });

  it("refuses a second live Core before it can recover the first Core's execution", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    let release!: (result: NativeTurnResult) => void;
    f.adapter.execute = async () =>
      new Promise((resolve) => {
        release = resolve;
      });
    f.send();
    f.service.start();
    await until(
      () => f.deliveries.list(f.session.id)[0]?.state === "awaiting_result",
    );
    const other = new ProxyDeliveryService(
      f.database,
      f.deliveries,
      f.routes,
      f.messages,
      () => {},
      f.adapter,
    );
    expect(() => other.start()).toThrow(/另一个 Core/);
    expect(f.deliveries.list(f.session.id)[0]?.state).toBe("awaiting_result");
    release({
      outcome: "reported",
      text: "done",
      nativeSessionId: "native-123",
      exitCode: 0,
    });
    await until(
      () => f.deliveries.list(f.session.id)[0]?.state === "completed",
    );
    await f.service.stop();
    other.start();
    await other.stop();
  });

  it("verifies the connection once and resumes later tasks without repeated probes", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    f.adapter.verify = async () => {
      throw new Error("Must not probe on every message");
    };
    f.send();
    f.service.start();
    await until(
      () => f.deliveries.list(f.session.id)[0]?.state === "completed",
    );
    expect(f.calls).toHaveLength(1);
    f.send("Continue this conversation");
    await until(() =>
      f.deliveries
        .list(f.session.id)
        .every((item) => item.state === "completed"),
    );
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((call) => call.startsWith("native-123:"))).toBe(true);
  });

  it("requests server cancellation and retains uncertainty without replaying the task", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    let aborts = 0;
    f.adapter.abort = async () => {
      aborts++;
    };
    f.adapter.execute = async (_snapshot, _prompt, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new ProxyProcessError("Stopped while executing", true)),
          { once: true },
        );
      });
    f.send();
    f.service.start();
    await until(
      () => f.deliveries.list(f.session.id)[0]?.state === "awaiting_result",
    );
    const delivery = f.deliveries.list(f.session.id)[0]!;
    await f.service.cancel(delivery.id);
    expect(aborts).toBe(1);
    expect(f.deliveries.get(delivery.id)?.state).toBe("unknown");
  });

  it("shows a failed re-verification as blocked instead of continuing to advertise readiness", async () => {
    const f = fixture();
    await f.service.verify(f.session.id, f.proxy.agent.id, 2);
    f.adapter.verify = async () => {
      throw new Error("Native history missing");
    };
    await expect(
      f.service.verify(f.session.id, f.proxy.agent.id, 2),
    ).rejects.toThrow(/history missing/);
    expect(f.routes.get(f.proxy.agent.id)).toMatchObject({
      bindingStatus: "blocked",
      lastError: "Native history missing",
      bindingVersion: 2,
    });
    expect(f.calls).toHaveLength(0);
  });

  it("returns a queued cancellation to the original host without starting the native tool", async () => {
    const f = fixture();
    const message = f.send();
    const delivery = f.deliveries.list(f.session.id)[0]!;
    await f.service.cancel(delivery.id);
    expect(f.calls).toHaveLength(0);
    expect(f.messages.findById(message.id)?.processingStatus).toBe("failed");
    const report = f.messageService.claimNext(f.host.id, { types: ["result"] });
    expect(report?.payload).toMatchObject({
      status: "cancelled",
      inReplyToMessageId: message.id,
    });
    expect(f.deliveries.get(delivery.id)?.resultMessageId).toBe(report?.id);
  });
});
