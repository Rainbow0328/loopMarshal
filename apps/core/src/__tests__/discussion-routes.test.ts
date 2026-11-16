import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { startCoreServer } from "../runtime.js";
import { DatabaseManager, ModelConfigRepository } from "@loopmarshal/store";

afterEach(() => vi.unstubAllEnvs());
describe("discussion and installation API", () => {
  it("keeps saved model credentials separate from environment-based models and CLI credentials on startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopmarshal-model-isolation-"));
    const path = join(root, "core.sqlite");
    vi.stubEnv("LOOPMARSHAL_KNOWLEDGE_ROOT", join(root, "knowledge"));
    vi.stubEnv(
      "LOOPMARSHAL_USER_PREFERENCES_PATH",
      join(root, "preferences.json"),
    );
    vi.stubEnv("OPENAI_API_KEY", "environment-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://environment.example/v1");
    const database = new DatabaseManager(path);
    database.migrate();
    const models = new ModelConfigRepository(database.connection);
    for (const id of ["first", "second"])
      models.upsert({
        id,
        name: id,
        provider: "openai",
        modelId: id,
        apiKey: `${id}-private-key`,
        baseUrl: `https://${id}.example/v1`,
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        contextReserveTokens: 100,
        createdAt: "now",
        updatedAt: "now",
      });
    database.close();
    const core = await startCoreServer({
      host: "127.0.0.1",
      port: 0,
      databasePath: path,
    });
    try {
      expect(process.env.OPENAI_API_KEY).toBe("environment-key");
      expect(process.env.OPENAI_BASE_URL).toBe(
        "https://environment.example/v1",
      );
    } finally {
      await core.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires management authorization and completes discussion, review and source retrieval through HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopmarshal-upgrade-api-"));
    vi.stubEnv("LOOPMARSHAL_KNOWLEDGE_ROOT", join(root, "knowledge"));
    vi.stubEnv("OPENAI_API_KEY", "environment-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://environment.example/v1");
    vi.stubEnv(
      "LOOPMARSHAL_USER_PREFERENCES_PATH",
      join(root, "preferences.json"),
    );
    const model = createHttpServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      expect(req.headers.authorization).toBe("Bearer model-secret");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: input.messages.some((m: any) =>
                  m.content.includes("知识草稿"),
                )
                  ? "review draft"
                  : "discussion answer",
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
    const core = await startCoreServer({
      host: "127.0.0.1",
      port: 0,
      databasePath: join(root, "core.sqlite"),
    });
    const base = `http://127.0.0.1:${(core.server.server.address() as { port: number }).port}`;
    const token = (
      (await (await fetch(base + "/api/local-auth")).json()) as any
    ).token;
    const request = async (path: string, method = "GET", data?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          "x-loopmarshal-management-token": token,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return {
        status: response.status,
        data: (await response.json()) as any,
        cache: response.headers.get("cache-control"),
      };
    };
    try {
      for (const path of ["/api/discussions", "/api/tool-installer"])
        expect((await fetch(base + path)).status).toBe(403);
      expect(
        (
          await request("/api/tool-installer/jobs", "POST", {
            toolId: "malicious;command",
            root,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/api/discussions", "POST", {
            name: "bad",
            modelIds: [],
            cliMembers: [],
          })
        ).status,
      ).toBe(400);
      const savedModel = await request("/api/models", "POST", {
        id: "test-model",
        name: "test",
        provider: "openai",
        modelId: "test",
        apiKey: "model-secret",
        baseUrl: modelBase,
      });
      expect(JSON.stringify(savedModel.data)).not.toContain("model-secret");
      expect(process.env.OPENAI_API_KEY).toBe("environment-key");
      expect(process.env.OPENAI_BASE_URL).toBe(
        "https://environment.example/v1",
      );
      expect(JSON.stringify((await request("/api/models")).data)).not.toContain(
        "model-secret",
      );
      const created = await request("/api/discussions", "POST", {
        name: "API room",
        modelIds: ["test-model"],
      });
      expect(created.status).toBe(200);
      expect(created.cache).toBe("no-store");
      const room = created.data.data;
      const sent = await request(
        `/api/discussions/${room.id}/messages`,
        "POST",
        { content: "discuss a plan", memberIds: ["test-model"] },
      );
      expect(sent.status).toBe(200);
      expect(sent.data.data.map((m: any) => m.content)).toEqual([
        "discuss a plan",
        "discussion answer",
      ]);
      const ids = sent.data.data.map((m: any) => m.id);
      const draft = await request(
        `/api/discussions/${room.id}/knowledge/draft`,
        "POST",
        { modelId: "test-model", sourceIds: ids },
      );
      expect(draft.data.data.content).toBe("review draft");
      const saved = await request(
        `/api/discussions/${room.id}/knowledge`,
        "POST",
        { title: "Approved", content: "edited by user", sourceIds: ids },
      );
      expect(saved.status).toBe(200);
      const sources = await request(
        `/api/discussions/${room.id}/knowledge/${saved.data.data.id}/sources`,
      );
      expect(sources.data.data).toHaveLength(2);
      expect(
        (await request(`/api/discussions/${room.id}/messages?limit=0`)).status,
      ).toBe(400);
    } finally {
      await core.close();
      await new Promise<void>((done) => model.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
