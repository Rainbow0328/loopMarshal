import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const root = await mkdtemp(join(tmpdir(), "loopmarshal-credentials-"));
let core;
try {
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  };
  core = await startCoreServer(config);
  let baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  const manager = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const created = await manager.createSession({
    sessionName: "credential-test",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const worker = await manager.joinSession(created.session.id, {
    agentName: "前端开发",
    displayName: "前端开发",
    role: "worker",
    roleDescription: "Frontend",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const issued = await manager.issueMemberCredential(
    created.session.id,
    worker.agent.id,
    "worker send",
  );
  let member = createLoopMarshalClient({
    baseUrl,
    headers: { authorization: `Bearer ${issued.token}` },
  });
  const input = {
    sessionName: created.session.name,
    from: worker.agent.agentName,
    to: [created.agent.agentName],
    type: "task_report",
    content: "ready",
    idempotencyKey: "credential-test",
  };
  const sent = await member.sendByName(input);
  assert.equal(sent[0].fromAgentId, worker.agent.id);
  assert.equal(sent[0].toAgentId, created.agent.id);
  await assert.rejects(
    () =>
      member.sendByName({
        ...input,
        from: created.agent.agentName,
        to: [worker.agent.agentName],
        type: "task",
        idempotencyKey: "spoof",
      }),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    () => member.listToolInstallations(),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    () => member.discoverTools(),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    () => member.listToolConfigProfiles(),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    () =>
      member.sendMessage({
        sessionId: created.session.id,
        fromAgentId: created.agent.id,
        toAgentId: worker.agent.id,
        type: "task",
        payload: "spoof",
      }),
    (error) => error.statusCode === 403,
  );
  const invalid = createLoopMarshalClient({
    baseUrl,
    headers: {
      authorization: "Bearer lm_member_invalid",
      "x-loopmarshal-management-token": token,
    },
  });
  await assert.rejects(
    () => invalid.sendByName(input),
    (error) => error.statusCode === 403,
  );
  await core.close();
  core = await startCoreServer(config);
  baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  member = createLoopMarshalClient({
    baseUrl,
    headers: { authorization: `Bearer ${issued.token}` },
  });
  assert.equal((await member.sendByName(input))[0].id, sent[0].id);
  const restartedManager = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const listed = await restartedManager.listMemberCredentials(
    created.session.id,
    worker.agent.id,
  );
  assert.equal(JSON.stringify(listed).includes(issued.token), false);
  await restartedManager.revokeMemberCredential(
    created.session.id,
    worker.agent.id,
    issued.credential.id,
  );
  await assert.rejects(
    () => member.sendByName(input),
    (error) => error.statusCode === 403,
  );
  console.log(
    JSON.stringify({
      passed: true,
      senderScope: true,
      managementDenied: true,
      revoked: true,
      restart: true,
      idempotent: true,
    }),
  );
} finally {
  if (core) await core.close();
  await rm(root, { recursive: true, force: true });
}
