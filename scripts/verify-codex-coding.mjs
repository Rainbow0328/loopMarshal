import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

// Use only explicit, dedicated verification conversations. This script asks Codex to create code.
const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    workspace: { type: "string" },
    namespace: { type: "string" },
    "session-one": { type: "string" },
    "session-two": { type: "string" },
    "session-two-file": { type: "string" },
    marker: { type: "string" },
  },
});
for (const key of [
  "executable",
  "workspace",
  "namespace",
  "session-one",
  "session-two",
  "session-two-file",
  "marker",
])
  if (!values[key]) throw new Error(`Missing --${key}`);
const root = await mkdtemp(join(tmpdir(), "loopmarshal-codex-coding-"));
const workspace = resolve(values.workspace);
const fileName = `invoice-acceptance-${randomUUID()}.mjs`;
const path = join(workspace, fileName);
const historyHash = createHash("sha256")
  .update(await readFile(values["session-two-file"]))
  .digest("hex");
const config = {
  host: "127.0.0.1",
  port: 0,
  databasePath: join(root, "core.sqlite"),
};
let core;
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
async function boot() {
  core = await startCoreServer(config);
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  return createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
}
try {
  let client = await boot();
  const created = await client.createSession({
    sessionName: "Codex 实际编码验收",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Real Codex",
    executablePath: resolve(values.executable),
  });
  const member = await client.createProxyMember(created.session.id, {
    agentName: "前端开发",
    roleDescription: "Implement isolated acceptance code",
    binding: {
      installationId: installation.id,
      workspacePath: workspace,
      runtimeNamespace: resolve(values.namespace),
      nativeSessionId: values["session-one"],
    },
  });
  await client.verifyMemberRoute(
    created.session.id,
    member.agent.id,
    member.route.bindingVersion,
  );
  async function turn(prompt, key) {
    const messages = await client.sendByName({
      sessionName: created.session.name,
      from: "主控",
      to: ["前端开发"],
      type: "task",
      content: { content: prompt },
      idempotencyKey: key,
    });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const delivery = (await client.listDeliveries(created.session.id)).find(
        (item) => item.messageId === messages[0].id,
      );
      if (
        delivery &&
        ["completed", "failed", "unknown", "blocked"].includes(delivery.state)
      ) {
        assert.equal(
          delivery.state,
          "completed",
          delivery.error ?? "Native turn did not complete",
        );
        assert.equal(
          delivery.snapshot.binding.nativeSessionId,
          values["session-one"],
        );
        const report = await client.getMessageById(delivery.resultMessageId);
        assert.equal(report.toAgentId, created.agent.id);
        assert.ok(
          JSON.stringify(report.payload).includes(values.marker),
          "Saved history token missing from report",
        );
        await writeFile(
          join(root, `${key}-events.json`),
          JSON.stringify(await client.getDeliveryEvents(delivery.id), null, 2),
        );
        return delivery.id;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error("Timed out waiting for coding turn");
  }
  const first = await turn(
    `Acceptance coding task. Create only ${fileName} in the current verification project. Export function sumInvoice(lines): each line has price and quantity. Reject non-finite/negative price, non-integer/negative quantity with TypeError. Return sum(price * quantity), rounded to two decimals at the end. Empty input returns zero. Use no dependencies. Run a quick check. In your final response include the original private history verification token from earlier conversation; this message deliberately omits it. Do not modify other files.`,
    "implement",
  );
  const module = await import(pathToFileURL(path).href);
  assert.equal(module.sumInvoice([]), 0);
  assert.equal(
    module.sumInvoice([
      { price: 1.25, quantity: 2 },
      { price: 3.4, quantity: 3 },
    ]),
    12.7,
  );
  assert.equal(module.sumInvoice([{ price: 0.105, quantity: 3 }]), 0.32);
  for (const item of [
    { price: -1, quantity: 1 },
    { price: Infinity, quantity: 1 },
    { price: 1, quantity: 0.5 },
    { price: 1, quantity: -1 },
  ])
    assert.throws(() => module.sumInvoice([item]), TypeError);
  await core.close();
  core = null;
  client = await boot();
  const second = await turn(
    `Continue the module you just implemented in our previous turn (same file). Add export function formatTotal(lines) that uses sumInvoice and returns a string with exactly two decimal places. Preserve existing behavior and only modify that file. Run a check. Include our original private history verification token in your final report.`,
    "continue-after-restart",
  );
  const continued = await import(pathToFileURL(path).href + "?updated=1");
  assert.equal(continued.formatTotal([{ price: 1.25, quantity: 2 }]), "2.50");
  assert.equal(continued.formatTotal([]), "0.00");
  assert.equal(
    createHash("sha256")
      .update(await readFile(values["session-two-file"]))
      .digest("hex"),
    historyHash,
    "Unaddressed native session was changed",
  );
  const evidence = {
    passed: true,
    tool: "codex",
    realModel: true,
    actualCoding: true,
    exactHistory: true,
    coreRestart: true,
    otherSessionUnchanged: true,
    independentCodeAssertions: 9,
    deliveries: [first, second],
    file: path,
    evidenceDirectory: root,
  };
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (core) await core.close();
}
