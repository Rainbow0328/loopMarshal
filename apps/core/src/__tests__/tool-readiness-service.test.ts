import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createProxyFixture } from "./proxy-fixture.js";
import { ToolConfigService } from "../services/tool-config-service.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
function fixture() {
  const f = createProxyFixture();
  cleanups.push(f.close);
  const cli = join(f.directory, "mimo.cjs");
  const log = join(f.directory, "checks.jsonl");
  const fail = join(f.directory, "fail");
  writeFileSync(
    cli,
    `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(fs.existsSync(${JSON.stringify(fail)})){console.error('private-check-secret');process.exit(4)}if(args[0]==='--version')console.log('0.1.16');else if(args.join(' ')==='debug config')console.log(JSON.stringify({provider:{local:{options:{apiKey:'private-check-secret'}}}}));else process.exit(99);`,
  );
  const installation = f.routeService.createInstallation({
    toolId: "mimo",
    displayName: "MiMo",
    executablePath: cli,
    executableArgs: ["--pure"],
  });
  const service = new ToolConfigService(
    f.database,
    f.routeService,
    join(f.directory, "test.sqlite"),
  );
  const configRoot = join(f.directory, "config");
  mkdirSync(configRoot);
  const profile = service.createProfile({
    installationId: installation.id,
    configRoot,
    name: "MiMo",
  });
  return { ...f, installation, service, profile, log, fail };
}

describe("real tool readiness checks", () => {
  it("checks startup and vendor config without a session service, task, or credential output", async () => {
    const f = fixture();
    const checked = await f.service.checkInstallation(f.installation.id);
    expect(checked).toMatchObject({
      availability: { status: "available" },
      version: "0.1.16",
      checkedAt: expect.any(String),
    });
    expect(
      readFileSync(f.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([["--version"], ["debug", "config"]]);
    expect(JSON.stringify(checked)).not.toContain("private-check-secret");
  });
  it("rechecks repaired configuration and failed startup without retaining a false unavailable state", async () => {
    const f = fixture();
    const path = join(f.profile.configRoot, "mimocode.json");
    writeFileSync(path, '{"apiKey":"private-check-secret", broken');
    const invalid = await f.service.checkInstallation(f.installation.id);
    expect(invalid.availability).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("配置"),
    });
    expect(JSON.stringify(invalid)).not.toContain("private-check-secret");
    writeFileSync(path, "{}");
    writeFileSync(f.fail, "");
    const failed = await f.service.checkInstallation(f.installation.id);
    expect(failed.availability.status).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("private-check-secret");
    unlinkSync(f.fail);
    expect(
      (await f.service.checkInstallation(f.installation.id)).availability
        .status,
    ).toBe("available");
  });
  it("uses the real endpoint health response and detects repair, authentication errors, and service shutdown", async () => {
    const f = fixture();
    let healthy = false;
    let status = 200;
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy, version: "0.1.16" }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    let closed = false;
    cleanups.push(() =>
      closed
        ? undefined
        : new Promise<void>((done) => server.close(() => done())),
    );
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(
      (await f.service.checkInstallation(f.installation.id, endpoint))
        .availability.status,
    ).toBe("unavailable");
    healthy = true;
    expect(
      (await f.service.checkInstallation(f.installation.id, endpoint))
        .availability.status,
    ).toBe("available");
    status = 401;
    expect(
      (await f.service.checkInstallation(f.installation.id, endpoint))
        .availability.reason,
    ).toContain("认证");
    expect(paths).toEqual([
      "/global/health",
      "/global/health",
      "/global/health",
    ]);
    await new Promise<void>((done) => server.close(() => done()));
    closed = true;
    expect(
      (await f.service.checkInstallation(f.installation.id, endpoint))
        .availability.status,
    ).toBe("unavailable");
    expect(
      (await f.service.checkInstallation(f.installation.id)).availability
        .status,
    ).toBe("available");
  });
  it("recognizes MiMo's official home and repairs only an empty legacy auto-detected config root", () => {
    const f = fixture();
    const xdg = join(f.directory, "xdg");
    const oldRoot = join(xdg, "mimocode");
    mkdirSync(oldRoot, { recursive: true });
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    vi.stubEnv("MIMOCODE_HOME", undefined);
    const old = f.service.createProfile({
      installationId: f.installation.id,
      configRoot: oldRoot,
      name: "Old detected root",
    });
    const nativeHome = join(f.directory, "official-home");
    mkdirSync(join(nativeHome, "config"), { recursive: true });
    vi.stubEnv("MIMOCODE_HOME", nativeHome);
    expect(f.service.defaults().mimo).toBe(join(nativeHome, "config"));
    expect(
      f.service.listProfiles().find((item) => item.id === old.id)?.configRoot,
    ).toBe(join(nativeHome, "config"));
    expect(
      f.service.listProfiles().find((item) => item.id === f.profile.id)
        ?.configRoot,
    ).toBe(f.profile.configRoot);
    writeFileSync(join(oldRoot, "mimocode.jsonc"), '{"model":"local/test"}');
    expect(
      f.service.listProfiles().find((item) => item.id === old.id)?.configRoot,
    ).toBe(oldRoot);
    expect(readFileSync(join(oldRoot, "mimocode.jsonc"), "utf8")).toBe(
      '{"model":"local/test"}',
    );
  });
});
