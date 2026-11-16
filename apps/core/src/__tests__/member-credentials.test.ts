import { afterEach, describe, expect, it } from "vitest";
import { createProxyFixture } from "./proxy-fixture.js";
import { MemberCredentialService } from "../services/member-credential-service.js";
import { buildNativeInvocation } from "../services/native-session-adapters.js";
import { createToolInstallationInputSchema } from "@loopmarshal/protocol";
import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

describe("member send credentials", () => {
  it("persists only a digest, enforces sender/session scope and immediately revokes", () => {
    const f = createProxyFixture();
    cleanup.push(f.close);
    const service = new MemberCredentialService(f.database);
    const issued = service.issue(f.session.id, f.proxy.agent.id, "worker test");
    const saved = f.database.prepare("SELECT * FROM member_credentials").get();
    expect(JSON.stringify(saved)).not.toContain(issued.token);
    expect(
      JSON.stringify(service.list(f.session.id, f.proxy.agent.id)),
    ).not.toContain("token_hash");
    expect(() =>
      service.assertSender(issued.token, f.session.id, f.proxy.agent.id),
    ).not.toThrow();
    expect(() =>
      service.assertSender(issued.token, f.session.id, f.host.id),
    ).toThrow();
    expect(() =>
      service.assertSender(issued.token, "another-session", f.proxy.agent.id),
    ).toThrow();
    service.revoke(f.session.id, f.proxy.agent.id, issued.credential.id);
    expect(() => service.authenticate(issued.token)).toThrow();
    expect(
      service.list(f.session.id, f.proxy.agent.id)[0]?.revokedAt,
    ).toBeTruthy();
  });

  it("does not inherit manager secrets and resolves only explicit supported model environment references", () => {
    const f = createProxyFixture();
    cleanup.push(f.close);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "model-test-only";
    try {
      const snapshot = {
        installation: f.proxy.installation!,
        binding: f.proxy.route.binding!,
        nativeSessionKey: "fixture",
      };
      expect(
        buildNativeInvocation(snapshot, "task").env.OPENAI_API_KEY,
      ).toBeUndefined();
      const environment = buildNativeInvocation(snapshot, "task").env;
      const pathKey = Object.keys(environment).find(
        (key) => key.toUpperCase() === "PATH",
      )!;
      expect(environment[pathKey]?.split(delimiter)[0]).toBe(
        dirname(process.execPath),
      );
      snapshot.installation.environmentKeys = ["OPENAI_API_KEY"];
      expect(buildNativeInvocation(snapshot, "task").env.OPENAI_API_KEY).toBe(
        "model-test-only",
      );
      expect(
        buildNativeInvocation(snapshot, "task").env
          .LOOPMARSHAL_MANAGEMENT_TOKEN,
      ).toBeUndefined();
      delete process.env.OPENAI_API_KEY;
      expect(() => buildNativeInvocation(snapshot, "task")).toThrow(/missing/);
      expect(
        createToolInstallationInputSchema.safeParse({
          toolId: "codex",
          displayName: "bad",
          executablePath: process.execPath,
          environmentKeys: ["NODE_OPTIONS"],
        }).success,
      ).toBe(false);
      expect(
        createToolInstallationInputSchema.safeParse({
          toolId: "qwen",
          displayName: "bad",
          executablePath: process.execPath,
          executableArgs: ["--openai-api-key=secret"],
        }).success,
      ).toBe(false);
      expect(
        createToolInstallationInputSchema.safeParse({
          toolId: "qwen",
          displayName: "bad",
          executablePath: process.execPath,
          executableArgs: ["--resume=other-session"],
        }).success,
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("does not silently select ZCode's headless yolo default", () => {
    const f = createProxyFixture();
    cleanup.push(f.close);
    mkdirSync(join(f.directory, ".zcode"));
    const snapshot = {
      installation: { ...f.proxy.installation!, toolId: "zcode" as const },
      binding: f.proxy.route.binding!,
      nativeSessionKey: "fixture",
    };
    const plan = buildNativeInvocation(snapshot, "task");
    expect(plan.args[plan.args.indexOf("--mode") + 1]).toBe("build");
    expect(plan.env.ZCODE_DATA_BASE_DIR).toBe(f.directory);
    expect(plan.env.ZCODE_SESSION_DB_PATH).toContain("db.sqlite");
  });
});
