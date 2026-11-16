import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiscussionCliService } from "../services/discussion-cli-service.js";
import { parseNativeConfig } from "../services/native-config-adapters.js";
import type { DiscussionMember, ToolInstallation } from "@loopmarshal/protocol";

const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
describe("discussion CLI isolation and exact resumption", () => {
  it("copies only model configuration, disables tools and resumes exactly the returned Codex ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopmarshal-discussion-"));
    dirs.push(root);
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(
      join(source, "config.toml"),
      'model="test"\n[shell_environment_policy]\ninherit="all"\n[mcp_servers.danger]\ncommand="danger"\n',
    );
    const member: DiscussionMember = {
      id: "member",
      kind: "cli",
      name: "codex",
      runtimeNamespace: source,
    };
    const installation: ToolInstallation = {
      id: "tool",
      toolId: "codex",
      displayName: "codex",
      executablePath: process.execPath,
      executableArgs: [],
      environmentKeys: [],
      version: null,
      createdAt: "now",
      updatedAt: "now",
    };
    const runner = vi.fn(async (plan, options) => {
      expect(plan.cwd).toBe(
        join(root, "runtime", "room", "member", "workspace"),
      );
      expect(plan.args).toContain('sandbox_mode="read-only"');
      expect(plan.args).toContain("features.shell_tool=false");
      expect(plan.input).toBe("question");
      const config = parseNativeConfig(
        readFileSync(join(plan.env.CODEX_HOME, "config.toml"), "utf8"),
        true,
      );
      expect(config.model).toBe("test");
      expect(config.mcp_servers).toBeUndefined();
      expect(config.shell_environment_policy).toBeUndefined();
      options.onStarted?.(123);
      options.onLine(
        JSON.stringify({ type: "thread.started", thread_id: "native-123" }),
      );
      options.onLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "answer" },
        }),
      );
      options.onLine(JSON.stringify({ type: "turn.completed" }));
      return { exitCode: 0, stderr: "" };
    });
    const service = new DiscussionCliService(join(root, "runtime"), runner);
    const save = vi.fn((id: string) => {
      if (id) member.nativeSessionId = id;
      else member.blocked = true;
    });
    expect(
      await service.reply(
        "room",
        member,
        installation,
        "question",
        new AbortController().signal,
        save,
      ),
    ).toBe("answer");
    expect(save).toHaveBeenCalledWith("native-123");
    expect(
      await service.reply(
        "room",
        member,
        installation,
        "question",
        new AbortController().signal,
        save,
      ),
    ).toBe("answer");
    expect(runner.mock.calls[1]?.[0].args).toEqual(
      expect.arrayContaining(["resume", "native-123"]),
    );
    const mismatched = new DiscussionCliService(
      join(root, "runtime"),
      async (_plan, options) => {
        options.onLine('{"type":"thread.started","thread_id":"wrong-id"}');
        return { exitCode: 0, stderr: "" };
      },
    );
    await expect(
      mismatched.reply(
        "room",
        member,
        installation,
        "question",
        new AbortController().signal,
        save,
      ),
    ).rejects.toThrow();
    expect(member.nativeSessionId).toBe("native-123");
    expect(member.blocked).toBe(true);
  });
});
