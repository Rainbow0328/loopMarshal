import type { Command } from "commander";
import type { LoopMarshalClient } from "@loopmarshal/sdk";
import type { NamedSendInput, ProxyToolId } from "@loopmarshal/protocol";

export function registerProxyCommands(
  program: Command,
  client: LoopMarshalClient,
): void {
  const run = async (operation: () => Promise<unknown>) => {
    try {
      console.log(JSON.stringify(await operation(), null, 2));
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    }
  };
  const tools = program
    .command("tool")
    .description("Manage native coding tool installations");
  tools.command("list").action(() => run(() => client.listToolInstallations()));
  tools
    .command("add")
    .requiredOption(
      "--tool <id>",
      "codex, claude, mimo, zcode, qwen, opencode, gemini, kimi, cursor, droid, copilot",
    )
    .requiredOption("--path <path>", "Absolute executable path")
    .option("--name <name>", "Installation label")
    .option(
      "--environment-keys <keys>",
      "Explicit model environment variable names, comma separated; values are not stored",
    )
    .option(
      "--arg <arguments...>",
      "Fixed launcher arguments, for example --arg=--bare; do not put credentials here",
    )
    .action(
      (options: {
        tool: ProxyToolId;
        path: string;
        name?: string;
        environmentKeys?: string;
        arg?: string[];
      }) =>
        run(() =>
          client.createToolInstallation({
            toolId: options.tool,
            displayName: options.name ?? options.tool,
            executablePath: options.path,
            executableArgs: options.arg ?? [],
            environmentKeys:
              options.environmentKeys
                ?.split(",")
                .map((key) => key.trim())
                .filter(Boolean) ?? [],
          }),
        ),
    );

  const members = program
    .command("member")
    .description("Manage persistent session member routes");
  members
    .command("list")
    .requiredOption("--session <name>", "Collaboration session")
    .action((options: { session: string }) =>
      run(async () =>
        client.listMemberRoutes(
          (await client.getSessionByName(options.session)).id,
        ),
      ),
    );
  members
    .command("add")
    .argument("<name>", "Member name")
    .requiredOption("--session <name>", "Collaboration session")
    .requiredOption("--installation <id>", "Registered tool installation ID")
    .requiredOption("--native-session <id>", "Exact existing native session ID")
    .requiredOption("--workspace <path>", "Absolute project directory")
    .requiredOption("--namespace <path>", "Absolute tool data/config directory")
    .requiredOption("--duty <description>", "Worker responsibility")
    .option("--endpoint <url>", "Native session server")
    .option(
      "--zcode-mode <mode>",
      "ZCode build (default), edit, plan, guarded, yolo",
    )
    .action(
      (
        name: string,
        options: {
          session: string;
          installation: string;
          nativeSession: string;
          workspace: string;
          namespace: string;
          duty: string;
          endpoint?: string;
          zcodeMode?: import("@loopmarshal/protocol").NativeSessionBinding["zcodeMode"];
        },
      ) =>
        run(async () => {
          const session = await client.getSessionByName(options.session);
          return client.createProxyMember(session.id, {
            agentName: name,
            roleDescription: options.duty,
            binding: {
              installationId: options.installation,
              workspacePath: options.workspace,
              runtimeNamespace: options.namespace,
              nativeSessionId: options.nativeSession,
              ...(options.endpoint ? { endpoint: options.endpoint } : {}),
              ...(options.zcodeMode ? { zcodeMode: options.zcodeMode } : {}),
            },
          });
        }),
    );
  members
    .command("verify")
    .argument("<name>", "Member name")
    .requiredOption("--session <name>", "Collaboration session")
    .action((name: string, options: { session: string }) =>
      run(async () => {
        const session = await client.getSessionByName(options.session);
        const member = (await client.listMemberRoutes(session.id)).find(
          (item) => item.agent.agentName === name,
        );
        if (!member) throw new Error(`未找到成员：${name}`);
        return client.verifyMemberRoute(
          session.id,
          member.agent.id,
          member.route.bindingVersion,
        );
      }),
    );
  const findMember = async (sessionName: string, name: string) => {
    const session = await client.getSessionByName(sessionName);
    const member = (await client.listMemberRoutes(session.id)).find(
      (item) => item.agent.agentName === name,
    );
    if (!member) throw new Error(`未找到成员：${name}`);
    return member;
  };
  members
    .command("bind")
    .argument("<name>")
    .requiredOption("--session <name>", "Collaboration session")
    .requiredOption("--installation <id>", "Tool installation ID")
    .requiredOption("--native-session <id>", "Exact existing native session")
    .requiredOption("--workspace <path>", "Project directory")
    .requiredOption("--namespace <path>", "Tool data directory")
    .requiredOption("--reason <text>", "Reason for changing the binding")
    .option("--endpoint <url>", "Native server")
    .option(
      "--zcode-mode <mode>",
      "ZCode build (default), edit, plan, guarded, yolo",
    )
    .action(
      (
        name: string,
        options: {
          session: string;
          installation: string;
          nativeSession: string;
          workspace: string;
          namespace: string;
          reason: string;
          endpoint?: string;
          zcodeMode?: import("@loopmarshal/protocol").NativeSessionBinding["zcodeMode"];
        },
      ) =>
        run(async () => {
          const member = await findMember(options.session, name);
          return client.updateMemberRoute(
            member.route.sessionId,
            member.agent.id,
            {
              accessMode: "managed_proxy",
              expectedBindingVersion: member.route.bindingVersion,
              reason: options.reason,
              binding: {
                installationId: options.installation,
                nativeSessionId: options.nativeSession,
                workspacePath: options.workspace,
                runtimeNamespace: options.namespace,
                ...(options.endpoint ? { endpoint: options.endpoint } : {}),
                ...(options.zcodeMode ? { zcodeMode: options.zcodeMode } : {}),
              },
            },
          );
        }),
    );
  const credentials = members
    .command("credential")
    .description("Issue and revoke scoped member send credentials");
  credentials
    .command("issue")
    .argument("<name>")
    .requiredOption("--session <name>", "Collaboration session")
    .requiredOption("--label <text>", "Credential label")
    .action((name: string, options: { session: string; label: string }) =>
      run(async () => {
        const member = await findMember(options.session, name);
        return client.issueMemberCredential(
          member.route.sessionId,
          member.agent.id,
          options.label,
        );
      }),
    );
  credentials
    .command("list")
    .argument("<name>")
    .requiredOption("--session <name>", "Collaboration session")
    .action((name: string, options: { session: string }) =>
      run(async () => {
        const member = await findMember(options.session, name);
        return client.listMemberCredentials(
          member.route.sessionId,
          member.agent.id,
        );
      }),
    );
  credentials
    .command("revoke")
    .argument("<name>")
    .argument("<credential-id>")
    .requiredOption("--session <name>", "Collaboration session")
    .action(
      (name: string, credentialId: string, options: { session: string }) =>
        run(async () => {
          const member = await findMember(options.session, name);
          return client.revokeMemberCredential(
            member.route.sessionId,
            member.agent.id,
            credentialId,
          );
        }),
    );
  for (const disabled of [true, false]) {
    members
      .command(disabled ? "disable" : "enable")
      .argument("<name>")
      .requiredOption("--session <name>", "Collaboration session")
      .requiredOption("--reason <text>", "Reason for the change")
      .action((name: string, options: { session: string; reason: string }) =>
        run(async () => {
          const member = await findMember(options.session, name);
          const route = member.route;
          if (route.accessMode === "core_runtime")
            throw new Error("内置运行成员请通过运行设置管理。");
          return client.updateMemberRoute(route.sessionId, member.agent.id, {
            accessMode: route.accessMode,
            expectedBindingVersion: route.bindingVersion,
            disabled,
            reason: options.reason,
            ...(route.accessMode === "managed_proxy"
              ? { binding: route.binding! }
              : {}),
          } as import("@loopmarshal/protocol").UpdateMemberRouteInput);
        }),
      );
  }
  members
    .command("use-await")
    .argument("<name>")
    .requiredOption("--session <name>", "Collaboration session")
    .requiredOption("--mode <mode>", "mcp_await or cli_await")
    .requiredOption("--reason <text>", "Reason for changing the channel")
    .action(
      (
        name: string,
        options: {
          session: string;
          mode: "mcp_await" | "cli_await";
          reason: string;
        },
      ) =>
        run(async () => {
          const member = await findMember(options.session, name);
          return client.updateMemberRoute(
            member.route.sessionId,
            member.agent.id,
            {
              accessMode: options.mode,
              expectedBindingVersion: member.route.bindingVersion,
              reason: options.reason,
            },
          );
        }),
    );

  const deliveries = program
    .command("delivery")
    .description("Inspect, stop and reconcile native executions");
  deliveries
    .command("list")
    .requiredOption("--session <name>", "Collaboration session")
    .action((options: { session: string }) =>
      run(async () =>
        client.listDeliveries(
          (await client.getSessionByName(options.session)).id,
        ),
      ),
    );
  deliveries
    .command("events")
    .argument("<id>", "Delivery ID")
    .action((id: string) => run(() => client.getDeliveryEvents(id)));
  deliveries
    .command("cancel")
    .argument("<id>", "Delivery ID")
    .action((id: string) => run(() => client.cancelDelivery(id)));
  deliveries
    .command("reconcile")
    .argument("<id>", "Delivery ID")
    .requiredOption("--outcome <status>", "reported or failed")
    .requiredOption(
      "--summary <text>",
      "Native history and file review summary",
    )
    .option("--confirmed-stopped", "Confirm the native execution has stopped")
    .action(
      (
        id: string,
        options: {
          outcome: "reported" | "failed";
          summary: string;
          confirmedStopped?: boolean;
        },
      ) =>
        run(async () => {
          if (
            !options.confirmedStopped ||
            !["reported", "failed"].includes(options.outcome)
          )
            throw new Error(
              "需要确认原执行已停止，并指定 reported 或 failed。",
            );
          return client.reconcileDelivery(id, {
            outcome: options.outcome,
            summary: options.summary,
            confirmedStopped: true,
          });
        }),
    );

  program
    .command("send")
    .description("Send through the central session member registry")
    .requiredOption("--session <name>", "Collaboration session")
    .requiredOption("--from <member>", "Sender name")
    .requiredOption(
      "--to <members>",
      "Recipient names separated by commas, or all",
    )
    .requiredOption(
      "--type <type>",
      "task, task_report, question, answer, announcement",
    )
    .requiredOption("--content <json>", "JSON message content")
    .requiredOption(
      "--idempotency-key <key>",
      "Stable operation key; reuse when retrying",
    )
    .action(
      (options: {
        session: string;
        from: string;
        to: string;
        type: NamedSendInput["type"];
        content: string;
        idempotencyKey: string;
      }) =>
        run(() =>
          client.sendByName({
            sessionName: options.session,
            from: options.from,
            to: options.to.split(",").map((name) => name.trim()),
            type: options.type,
            content: JSON.parse(options.content) as unknown,
            idempotencyKey: options.idempotencyKey,
          }),
        ),
    );
}
