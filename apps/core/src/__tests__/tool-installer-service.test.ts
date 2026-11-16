import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProxyFixture } from "./proxy-fixture.js";
import { ToolInstallerService } from "../services/tool-installer-service.js";
import { ToolConfigService } from "../services/tool-config-service.js";
import { proxyEnvironment } from "../services/proxy-process.js";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = createProxyFixture();
  cleanups.push(f.close);
  const configs = new ToolConfigService(
    f.database,
    f.routeService,
    join(f.directory, "test.sqlite"),
  );
  return { ...f, configs };
}
describe("managed tool installation", () => {
  it("uses literal paths, registers managed folders, remembers roots and never overwrites an installation", async () => {
    const f = fixture();
    const root = join(f.directory, "中文 space & cache");
    const runner = vi.fn(async (plan) => {
      expect(plan.args).toContain("--registry=https://registry.npmjs.org");
      expect(plan.args).toContain(root + join("/tools", "codex"));
      expect(plan.args.at(-1)).toBe("@openai/codex@latest");
      expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
      const packageRoot = join(
        root,
        "tools",
        "codex",
        ...(process.platform === "win32"
          ? ["node_modules"]
          : ["lib", "node_modules"]),
        "@openai",
        "codex",
      );
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "codex.js"), "console.log('fixture');");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@openai/codex",
          version: "1.2.3",
          bin: { codex: "codex.js" },
        }),
      );
      return { exitCode: 0, stderr: "" };
    });
    const service = new ToolInstallerService(
      f.database,
      f.routeService,
      f.configs,
      runner,
      () => "npm-cli.js",
    );
    const job = service.start({ toolId: "codex", root });
    expect(() => service.start({ toolId: "qwen", root })).toThrow(/正在安装/);
    await vi.waitFor(() => expect(service.jobs()[0]?.status).toBe("installed"));
    expect(service.settings().root).toBe(root);
    const installation = f.routeService
      .listInstallations()
      .find((item) => item.id === service.jobs()[0]?.installationId)!;
    expect(installation.managedPaths?.configRoot).toBe(
      join(root, "config", "codex"),
    );
    expect(proxyEnvironment(installation).XDG_CACHE_HOME).toBe(
      join(root, "cache", "codex"),
    );
    expect(
      f.configs
        .listProfiles()
        .find((p) => p.id === service.jobs()[0]?.profileId)?.installationId,
    ).toBe(installation.id);
    expect(existsSync(join(root, "config", "codex"))).toBe(true);
    expect(() => service.start({ toolId: "codex", root })).toThrow(/已有内容/);
    expect(job.status).toBe("installing");
    expect(runner).toHaveBeenCalledTimes(1);
    await service.stop();
  });
  it("rejects untrusted tool IDs and missing npm before touching directories", () => {
    const f = fixture();
    const root = join(f.directory, "not-created");
    const runner = vi.fn();
    const service = new ToolInstallerService(
      f.database,
      f.routeService,
      f.configs,
      runner,
      () => null,
    );
    expect(() => service.start({ toolId: "codex", root })).toThrow(/npm/);
    expect(() =>
      service.start({ toolId: "injected;command" as never, root }),
    ).toThrow();
    expect(() => service.start({ toolId: "cursor", root })).toThrow(/官方安装/);
    expect(existsSync(root)).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
  it("persists failures without leaking process output or registering an unusable tool", async () => {
    const f = fixture();
    const runner = vi.fn(async () => ({
      exitCode: 1,
      stderr: "API_KEY=private-secret",
    }));
    const service = new ToolInstallerService(
      f.database,
      f.routeService,
      f.configs,
      runner,
      () => "npm-cli.js",
    );
    service.start({ toolId: "qwen", root: join(f.directory, "fail") });
    await vi.waitFor(() => expect(service.jobs()[0]?.status).toBe("failed"));
    expect(JSON.stringify(service.jobs())).not.toContain("private-secret");
    expect(service.jobs()[0]?.installationId).toBeNull();
    await service.stop();
  });
});
