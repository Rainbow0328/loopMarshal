import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager, ModelConfigRepository } from "@loopmarshal/store";
import { DiscussionService } from "../services/discussion-service.js";
import { createProxyFixture } from "./proxy-fixture.js";
import { join } from "node:path";
import { ToolConfigService } from "../services/tool-config-service.js";
import { DiscussionCliService } from "../services/discussion-cli-service.js";

afterEach(() => vi.unstubAllGlobals());
describe("discussion rooms", () => {
  it("sends only new room activity to an existing CLI conversation while retaining other members' replies", async () => {
    const f = createProxyFixture();
    try {
      const models = new ModelConfigRepository(f.database);
      models.upsert({
        id: "peer",
        name: "peer",
        provider: "openai",
        modelId: "peer",
        apiKey: "key",
        baseUrl: "https://example.invalid/v1",
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        contextReserveTokens: 100,
        createdAt: "now",
        updatedAt: "now",
      });
      const prompts: string[] = [];
      const cli = new DiscussionCliService(
        join(f.directory, "discussion-runtime"),
        async (plan, options) => {
          prompts.push(plan.input!);
          options.onStarted?.(123);
          options.onLine(
            '{"type":"thread.started","thread_id":"native-fixed"}',
          );
          options.onLine(
            '{"type":"item.completed","item":{"type":"agent_message","text":"cli reply"}}',
          );
          options.onLine('{"type":"turn.completed"}');
          return { exitCode: 0, stderr: "" };
        },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "peer opinion" } }],
              }),
            ),
        ),
      );
      const service = new DiscussionService(f.database, models, {
        members: f.routeService,
        configs: new ToolConfigService(
          f.database,
          f.routeService,
          join(f.directory, "test.sqlite"),
        ),
        cli,
      });
      const room = service.create(
        "mixed",
        ["peer"],
        [
          {
            installationId: f.proxy.installation!.id,
            runtimeNamespace: f.directory,
          },
        ],
      );
      const member = room.members.find((m) => m.kind === "cli")!;
      await service.send(room.id, "initial unique marker", [member.id, "peer"]);
      await service.send(room.id, "next question", [member.id]);
      expect(prompts[0]).toContain("initial unique marker");
      expect(prompts[1]).not.toContain("initial unique marker");
      expect(prompts[1]).toContain("peer opinion");
      expect(prompts[1]).toContain("next question");
      expect(
        service.get(room.id).members.find((m) => m.id === member.id)
          ?.nativeSessionId,
      ).toBe("native-fixed");
    } finally {
      f.close();
    }
  });
  it("marks interrupted CLI conversations for review instead of creating a replacement", () => {
    const db = new DatabaseManager(":memory:");
    db.migrate();
    try {
      const models = new ModelConfigRepository(db.connection);
      db.connection
        .prepare(
          "INSERT INTO discussion_rooms (id,name,members_json,created_at,busy) VALUES(?,?,?,?,1)",
        )
        .run(
          "interrupted",
          "interrupted",
          JSON.stringify([
            {
              id: "cli",
              kind: "cli",
              name: "cli",
              installationId: "tool",
              nativeSessionId: "native-saved",
            },
          ]),
          "now",
        );
      db.connection
        .prepare("INSERT INTO discussion_messages VALUES(?,?,?,?,?,?)")
        .run("pending", "interrupted", "cli", "thinking", "pending", "now");
      const service = new DiscussionService(db.connection, models);
      expect(service.get("interrupted").busy).toBe(false);
      expect(service.get("interrupted").members[0]).toMatchObject({
        nativeSessionId: "native-saved",
        blocked: true,
      });
      expect(service.messages("interrupted")[0]?.status).toBe("failed");
    } finally {
      db.close();
    }
  });
  it("records partial replies promptly, prevents concurrent turns and can stop pending members", async () => {
    const db = new DatabaseManager(":memory:");
    db.migrate();
    const models = new ModelConfigRepository(db.connection);
    for (const id of ["fast", "slow"])
      models.upsert({
        id,
        name: id,
        provider: "openai",
        modelId: id,
        apiKey: "key",
        baseUrl: "https://example.invalid/v1",
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        contextReserveTokens: 100,
        createdAt: "now",
        updatedAt: "now",
      });
    const service = new DiscussionService(db.connection, models);
    const room = service.create("live", ["fast", "slow"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        if (JSON.parse(options.body).model === "fast")
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "fast reply" } }],
            }),
          );
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        );
      }),
    );
    const sending = service.send(room.id, "question", ["fast", "slow"]);
    try {
      await vi.waitFor(() =>
        expect(
          service.messages(room.id).find((m) => m.speaker === "fast")?.content,
        ).toBe("fast reply"),
      );
      expect(service.get(room.id).busy).toBe(true);
      expect(
        service.messages(room.id).find((m) => m.speaker === "slow")?.status,
      ).toBe("pending");
      await expect(
        service.send(room.id, "duplicate", ["fast"]),
      ).rejects.toThrow(/尚未结束/);
      service.cancel(room.id);
      const messages = await sending;
      expect(messages.find((m) => m.speaker === "slow")?.status).toBe("failed");
      expect(service.get(room.id).busy).toBe(false);
    } finally {
      await service.stop();
      db.close();
    }
  });
  it("only shares reviewed knowledge with authorized collaborations and paginates room history", () => {
    const f = createProxyFixture();
    try {
      const models = new ModelConfigRepository(f.database);
      models.upsert({
        id: "a",
        name: "a",
        provider: "openai",
        modelId: "a",
        apiKey: "key",
        baseUrl: "https://example.invalid/v1",
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        contextReserveTokens: 100,
        createdAt: "now",
        updatedAt: "now",
      });
      const service = new DiscussionService(f.database, models);
      const room = service.create("reference", ["a"]);
      const other = service.create("private", ["a"]);
      for (let i = 0; i < 110; i++)
        f.database
          .prepare("INSERT INTO discussion_messages VALUES(?,?,?,?,?,?)")
          .run(`msg-${i}`, room.id, "user", `text ${i}`, "complete", "now");
      expect(service.messages(room.id)).toHaveLength(100);
      expect(service.messages(room.id)[0]?.id).toBe("msg-10");
      expect(service.messages(room.id, "msg-10")).toHaveLength(10);
      expect(() => service.messages(other.id, "msg-10")).toThrow(/游标/);
      const saved = service.saveKnowledge(
        room.id,
        "agreed",
        "reviewed summary",
        ["msg-0"],
      );
      expect(service.readShared(f.session.id).entries).toEqual([]);
      expect(() =>
        service.readShared(f.session.id, { roomId: room.id }),
      ).toThrow(/尚未获准/);
      service.setGrant(f.session.id, room.id, true);
      expect(
        service.readShared(f.session.id, { query: "summary" }).entries[0]?.id,
      ).toBe(saved.id);
      const evidence = service.readShared(f.session.id, {
        entryId: saved.id,
        includeSources: true,
      }).entries[0];
      expect(evidence?.sources?.[0]?.content).toBe("text 0");
      expect(service.knowledgeSources(room.id, saved.id)[0]?.id).toBe("msg-0");
      for (let i = 0; i < 12; i++)
        service.saveKnowledge(room.id, `recent ${i}`, "other facts", ["msg-1"]);
      expect(service.readShared(f.session.id).entries).toHaveLength(8);
      expect(
        service
          .readShared(f.session.id, { query: "summary" })
          .entries.map((entry) => entry.id),
      ).toEqual([saved.id]);
      expect(service.readShared(f.session.id, { query: "%" }).entries).toEqual(
        [],
      );
      service.setGrant(f.session.id, room.id, false);
      expect(service.readShared(f.session.id).entries).toEqual([]);
      expect(() => service.knowledgeSources(other.id, saved.id)).toThrow();
    } finally {
      f.close();
    }
  });
  it("isolates rooms, shares a round snapshot and saves only validated knowledge sources", async () => {
    const db = new DatabaseManager(":memory:");
    db.migrate();
    const models = new ModelConfigRepository(db.connection);
    for (const id of ["a", "b"])
      models.upsert({
        id,
        name: id,
        provider: "openai",
        modelId: id,
        apiKey: "key",
        baseUrl: "https://example.invalid/v1",
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        contextReserveTokens: 100,
        createdAt: "2026",
        updatedAt: "2026",
      });
    const service = new DiscussionService(db.connection, models);
    const first = service.create("first", ["a", "b"]);
    const second = service.create("second", ["a"]);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: { body: string }) => {
        calls.push(options.body);
        return JSON.parse(options.body).model === "b"
          ? new Response("failed", { status: 503 })
          : new Response(
              JSON.stringify({ choices: [{ message: { content: "answer" } }] }),
              { status: 200 },
            );
      }),
    );
    const messages = await service.send(first.id, "question", ["a", "b"]);
    expect(messages.map((m) => m.status)).toEqual([
      "complete",
      "complete",
      "failed",
    ]);
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (call) => call.includes("question") && !call.includes("answer"),
      ),
    ).toBe(true);
    expect(service.messages(second.id)).toEqual([]);
    await expect(service.send(first.id, "next", ["unknown"])).rejects.toThrow();
    const source = messages[0]!.id;
    const draft = await service.draftKnowledge(first.id, "a", [source]);
    expect(draft.content).toBe("answer");
    const saved = service.saveKnowledge(
      first.id,
      "result",
      "reviewed",
      draft.sourceIds,
    );
    expect(service.knowledge(first.id)).toEqual([saved]);
    expect(service.knowledge(second.id)).toEqual([]);
    expect(() =>
      service.saveKnowledge(second.id, "x", "x", [source]),
    ).toThrow();
    db.close();
  });
});
