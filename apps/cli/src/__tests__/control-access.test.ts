import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopMarshalClient } from "@loopmarshal/sdk";
import { canControlApplication, McpAccessPolicy } from "../control/access.js";
import { callControlAction } from "../control/registry.js";
import { callControlMcpTool } from "../control/mcp-tools.js";

afterEach(() => vi.unstubAllEnvs());

describe("application access", () => {
  it.each([
    [undefined, undefined, true],
    ["host", undefined, true],
    ["worker", undefined, false],
    ["knowledge_keeper", undefined, false],
    ["invalid-role", undefined, false],
    [undefined, "member-token", false],
    ["host", "member-token", false],
  ])(
    "role %s with credential %s allows management: %s",
    (role, token, allowed) => {
      expect(canControlApplication(role, token)).toBe(allowed);
      expect(
        new McpAccessPolicy(role ?? "", token ?? "").canManageApplication,
      ).toBe(allowed);
    },
  );

  it("prevents simultaneous role escalation and management during attach", async () => {
    const policy = new McpAccessPolicy("", "");
    let release!: () => void;
    const pending = policy.attach(
      "worker",
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    expect(policy.canManageApplication).toBe(false);
    expect(policy.canUseHostTools).toBe(false);
    expect(() => policy.assertApplicationAccess()).toThrow();
    const invoke = vi.fn();
    await expect(policy.attach("host", invoke)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(invoke).not.toHaveBeenCalled();
    release();
    await pending;
    expect(policy.role).toBe("worker");
    expect(policy.canManageApplication).toBe(false);
    await expect(policy.attach("host", invoke)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("does not commit a role after a failed attach", async () => {
    const policy = new McpAccessPolicy("", "");
    await expect(
      policy.attach("worker", async () => {
        throw new Error("not found");
      }),
    ).rejects.toThrow("not found");
    expect(policy.role).toBeUndefined();
    expect(policy.canManageApplication).toBe(true);
    await policy.attach("host", async () => "ok");
    expect(policy.role).toBe("host");
  });

  it("rejects invalid and fixed roles before running the operation", async () => {
    const invoke = vi.fn();
    const policy = new McpAccessPolicy("worker", "");
    await expect(policy.attach("invalid", invoke)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(policy.attach("host", invoke)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("denies both application transports before any network request", async () => {
    const client = createLoopMarshalClient();
    const list = vi.spyOn(client, "listModels");
    vi.stubEnv("LOOPMARSHAL_ROLE", "worker");
    await expect(callControlAction(client, "model.list")).rejects.toMatchObject(
      { code: "PERMISSION_DENIED" },
    );
    await expect(
      callControlMcpTool(client, "model_list", {}),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(list).not.toHaveBeenCalled();
  });
});
