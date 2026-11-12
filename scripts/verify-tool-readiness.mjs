import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";
import {
  proxyEnvironment,
  resolveToolExecutable,
} from "../apps/core/dist/apps/core/src/services/proxy-process.js";

// Real startup/config/health checks only. No prompts, model calls, or session creation.
const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    executable: { type: "string" },
    artifacts: { type: "string" },
  },
});
if (
  !["mimo", "opencode"].includes(values.tool) ||
  !values.executable ||
  !values.artifacts
)
  throw new Error(
    "Provide --tool mimo|opencode --executable <CLI path> --artifacts <evidence directory>",
  );
const directory = await mkdtemp(join(tmpdir(), "loopmarshal-real-readiness-"));
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(directory, "knowledge");
process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
  directory,
  "preferences.json",
);
let core,
  child,
  closed = false,
  childClosed;
const digest = async (file) => {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
async function stop() {
  if (!child || closed) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        child.kill();
        done();
      });
      killer.once("close", done);
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
  let timer;
  try {
    await Promise.race([
      childClosed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test service did not stop")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "test.sqlite"),
  });
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(baseUrl + "/api/local-auth")).json();
  const client = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const installation = await client.createToolInstallation({
    toolId: values.tool,
    displayName: "Real readiness check",
    executablePath: resolve(values.executable),
  });
  const { defaults } = await client.listToolConfigProfiles();
  await client.createToolConfigProfile({
    installationId: installation.id,
    name: "Existing native configuration",
    configRoot: defaults[values.tool],
  });
  const watched =
    values.tool === "mimo" && process.env.MIMOCODE_HOME
      ? [
          "data/auth.json",
          "state/model.json",
          "config/mimocode.json",
          "config/mimocode.jsonc",
        ].map((file) => join(process.env.MIMOCODE_HOME, file))
      : [];
  const before = await Promise.all(watched.map(digest));
  const initial = await client.checkToolInstallation(installation.id);
  assert.equal(
    initial.availability.status,
    "available",
    JSON.stringify(initial),
  );
  const executable = resolveToolExecutable({
    ...installation,
    executableArgs: [],
  });
  const env = proxyEnvironment();
  for (const name of [
    "MIMOCODE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
  ])
    if (process.env[name]) env[name] = process.env[name];
  let output = "";
  child = spawn(
    executable.command,
    [
      ...executable.args,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      ...(values.tool === "mimo" ? ["--pure"] : []),
    ],
    {
      cwd: directory,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childClosed = new Promise((done) => {
    child.once("close", () => {
      closed = true;
      done();
    });
  });
  child.on("error", () => {
    closed = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-16000);
    });
  let endpoint;
  const deadline = Date.now() + 30000;
  while (!endpoint && Date.now() < deadline && !closed) {
    endpoint = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!endpoint) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(endpoint, "The official CLI must start its local service");
  const connected = await client.checkToolInstallation(installation.id, {
    endpoint,
  });
  assert.equal(
    connected.availability.status,
    "available",
    JSON.stringify(connected),
  );
  await stop();
  const stopped = await client.checkToolInstallation(installation.id, {
    endpoint,
  });
  assert.equal(stopped.availability.status, "unavailable");
  const installationStillWorks = await client.checkToolInstallation(
    installation.id,
  );
  assert.equal(installationStillWorks.availability.status, "available");
  assert.deepEqual(
    await Promise.all(watched.map(digest)),
    before,
    "Existing authentication, model selection and config must remain unchanged",
  );
  const evidence = {
    passed: true,
    tool: values.tool,
    executable: resolve(values.executable),
    configRoot: defaults[values.tool],
    version: initial.version,
    checkedExistingNativeConfig: true,
    realLocalServiceHealth: true,
    serviceShutdownDetected: true,
    toolAvailabilityIndependentOfService: true,
    credentialsAndModelSelectionUnchanged: true,
    modelPrompts: 0,
    sessionsCreated: 0,
    isolatedCoreDirectory: directory,
  };
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await stop();
  if (core) await core.close();
}
