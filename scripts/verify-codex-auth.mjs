import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";
import {
  proxyEnvironment,
  resolveToolExecutable,
  runProxyProcess,
} from "../apps/core/dist/apps/core/src/services/proxy-process.js";

// Check the actual Codex executable against a local provider, without real credentials or model calls.
const { values } = parseArgs({ options: { executable: { type: "string" } } });
if (!values.executable)
  throw new Error(
    "Provide --executable <installed Codex executable or launcher>",
  );
const root = await mkdtemp(join(tmpdir(), "loopmarshal-codex-auth-"));
const configRoot = join(root, "codex");
await mkdir(configRoot);
const requests = [];
const provider = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* Drain the request without retaining its prompt. */
  }
  requests.push({
    path: request.url,
    authorization: request.headers.authorization,
  });
  const item = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "CODEX_AUTH_OK", annotations: [] }],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.created",
      response: { id: "resp_test", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "CODEX_AUTH_OK",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
let core;
try {
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  });
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  const client = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Codex local auth test",
    executablePath: resolve(values.executable),
    environmentKeys: ["OPENAI_API_KEY"],
  });
  const { profile } = await client.createToolConfigProfile({
    installationId: installation.id,
    configRoot,
    name: "Isolated test",
  });
  await writeFile(
    join(configRoot, "config.toml"),
    `model = "mock"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local test"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`,
  );
  const executable = resolveToolExecutable(installation);
  const results = [];
  for (const mode of ["api_key", "environment"]) {
    const key = `local-test-${mode}`;
    const document = (await client.getToolConfigDocuments(profile.id))
      .documents[0];
    const preview = await client.previewToolConfig(profile.id, {
      documentId: document.id,
      expectedFingerprint: document.fingerprint,
      values:
        mode === "api_key"
          ? { provider_api_key: key }
          : { provider_env_key: "OPENAI_API_KEY" },
    });
    assert.ok(!JSON.stringify(preview).includes(key));
    await client.applyToolConfig(profile.id, preview.previewId);
    const env = proxyEnvironment();
    env.CODEX_HOME = configRoot;
    if (mode === "environment") env.OPENAI_API_KEY = key;
    const start = requests.length;
    let output = "";
    const result = await runProxyProcess(
      {
        ...executable,
        args: [
          ...executable.args,
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-",
        ],
        cwd: root,
        env,
        input: "Reply CODEX_AUTH_OK. Do not call tools.",
      },
      {
        signal: AbortSignal.timeout(45000),
        timeoutMs: 45000,
        onLine: (line) => {
          output += line + "\n";
        },
      },
    );
    assert.equal(result.exitCode, 0, result.stderr + output);
    assert.ok(
      output.includes("CODEX_AUTH_OK"),
      "Codex did not complete the local provider response",
    );
    const sent = requests
      .slice(start)
      .filter((request) => request.path.includes("/responses"));
    assert.ok(sent.length > 0);
    assert.ok(
      sent.every((request) => request.authorization === `Bearer ${key}`),
    );
    assert.ok(
      !JSON.stringify(await client.getToolConfigDocuments(profile.id)).includes(
        key,
      ),
    );
    results.push({
      mode,
      completed: true,
      exactAuthorization: true,
      keyMasked: true,
    });
  }
  const evidence = {
    passed: true,
    root,
    realCodexExecutable: true,
    localProviderOnly: true,
    results,
  };
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (core) await core.close();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
}
