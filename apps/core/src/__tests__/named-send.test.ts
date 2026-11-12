import { afterEach, describe, expect, it } from "vitest";
import { createProxyFixture } from "./proxy-fixture.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = createProxyFixture();
  cleanup.push(f.close);
  return f;
}

describe("named member dispatch", () => {
  it("fixes a broadcast's recipients across retries and rejects changed reuse of its key", () => {
    const f = fixture();
    const input = {
      sessionName: "test",
      from: "主控",
      to: ["all"],
      type: "task" as const,
      content: { task: "Implement" },
      idempotencyKey: "broadcast-1",
    };
    const first = f.messageService.sendByName(input);
    f.sessionService.joinSession({
      sessionId: f.session.id,
      agentName: "后来加入",
      displayName: "Later",
      role: "worker",
      roleDescription: "Review",
      platform: "unknown-cli",
      capabilities: [],
      connectionMode: "skill-bridge",
    });
    expect(f.messageService.sendByName(input)).toEqual(first);
    expect(first).toHaveLength(1);
    expect(f.deliveries.list(f.session.id)).toHaveLength(1);
    expect(() =>
      f.messageService.sendByName({ ...input, content: "Changed task" }),
    ).toThrow(/already used/);
  });

  it("rolls back every recipient when one recipient is missing", () => {
    const f = fixture();
    expect(() =>
      f.messageService.sendByName({
        sessionName: "test",
        from: "主控",
        to: ["前端开发", "missing"],
        type: "task",
        content: "Task",
        idempotencyKey: "invalid",
      }),
    ).toThrow();
    expect(f.deliveries.list(f.session.id)).toHaveLength(0);
  });

  it("routes questions to the native session but keeps announcements as informational messages", () => {
    const f = fixture();
    for (const type of [
      "question",
      "answer",
      "announcement",
      "task_report",
    ] as const) {
      f.messageService.sendByName({
        sessionName: "test",
        from: "主控",
        to: ["前端开发"],
        type,
        content: "Content",
        idempotencyKey: type,
      });
    }
    expect(f.deliveries.list(f.session.id)).toHaveLength(2);
  });
});
