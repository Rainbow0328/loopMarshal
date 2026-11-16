import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopMarshalClient } from "@loopmarshal/sdk";
import { z } from "zod";
import { action } from "../control/action.js";
import {
  callControlAction,
  describeControlAction,
  listControlActions,
} from "../control/registry.js";
import { callControlMcpTool, controlMcpTools } from "../control/mcp-tools.js";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("LOOPMARSHAL_ROLE", "");
  vi.stubEnv("LOOPMARSHAL_MEMBER_TOKEN", "");
  return createLoopMarshalClient();
}

describe("control operations", () => {
  it("keeps discovery, schemas and shortcut validation aligned", async () => {
    const client = fixture();
    const operations = listControlActions();
    expect(new Set(operations.map((o) => o.name)).size).toBe(operations.length);
    for (const operation of operations) {
      const description = describeControlAction(operation.name);
      expect(description.inputSchema.type).toBe("object");
      expect(description.description.length).toBeGreaterThan(0);
    }
    const listed = await callControlMcpTool(client, "app_capabilities", {
      group: "model",
    });
    expect(listed).toMatchObject({ actions: listControlActions("model") });
    const direct = controlMcpTools.find((t) => t.name === "session_create")!;
    expect(direct.inputSchema).toEqual(
      describeControlAction("session.create").inputSchema,
    );
    await expect(callControlAction(client, "not-real")).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
    });
  });

  it("uses defaults, rejects unknown fields, and hides enum/literal input values", async () => {
    const client = fixture();
    const execute = vi.fn(async (_c, input) => input);
    const operation = action(
      "test.validate",
      "fixture",
      z
        .object({
          count: z.number().default(5),
          mode: z.enum(["known"]).optional(),
          confirmed: z.literal(true).optional(),
        })
        .strict(),
      execute,
    );
    expect(await operation.execute(client, {})).toEqual({ count: 5 });
    for (const input of [
      { mode: "private-enum-secret" },
      { confirmed: "private-literal-secret" },
      { "private-field-secret": true },
    ]) {
      await expect(operation.execute(client, input)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.not.stringContaining("secret"),
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      callControlMcpTool(client, "app_call", {
        action: "model.list",
        "private-envelope-secret": true,
      }),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining("private-envelope-secret"),
    });
  });

  it("keeps CLI/MCP model saving and secret-free results identical", async () => {
    const client = fixture();
    const secret = "private-key";
    const save = vi.spyOn(client, "createModel").mockResolvedValue({
      id: "model",
      name: "Test",
      provider: "openai",
      modelId: "test",
      baseUrl: null,
      apiKey: null,
      hasApiKey: true,
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
      contextReserveTokens: 1000,
    });
    const input = {
      id: "model",
      name: "Test",
      provider: "openai",
      modelId: "test",
      apiKey: secret,
    };
    const cli = await callControlAction(client, "model.save", input);
    const mcp = await callControlMcpTool(client, "app_call", {
      action: "model.save",
      input,
    });
    expect(mcp).toEqual({ apiVersion: "1", data: cli });
    expect(save).toHaveBeenNthCalledWith(1, input);
    expect(save).toHaveBeenNthCalledWith(2, input);
    expect(JSON.stringify(mcp)).not.toContain(secret);
  });

  it("keeps Host messages on the desktop conversation path with a stable idempotency key", async () => {
    const client = fixture();
    vi.spyOn(client, "getSessionByName").mockResolvedValue({
      id: "session-123",
      hostAgentId: "host-456",
    } as Awaited<ReturnType<typeof client.getSessionByName>>);
    const send = vi
      .spyOn(client, "sendMessage")
      .mockImplementation(
        async (input) =>
          ({ ...input, id: "message" }) as Awaited<
            ReturnType<typeof client.sendMessage>
          >,
      );
    await callControlMcpTool(client, "session_message", {
      session: "项目",
      content: "继续任务",
      idempotencyKey: "request-1",
    });
    expect(send).toHaveBeenCalledWith({
      sessionId: "session-123",
      fromAgentId: "host-456",
      toAgentId: "host-456",
      type: "instruction",
      idempotencyKey: "request-1",
      payload: {
        kind: "web_user_message",
        source: "external_app",
        content: "继续任务",
      },
    });
  });
});
