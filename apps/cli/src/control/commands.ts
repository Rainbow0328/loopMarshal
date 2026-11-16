import type { Command } from "commander";
import type { LoopMarshalClient } from "@loopmarshal/sdk";
import {
  callControlAction,
  describeControlAction,
  listControlActions,
} from "./registry.js";
import { controlErrorDetails } from "./errors.js";
import { readControlInput, type InputOptions } from "./input.js";

export function registerControlCommands(
  program: Command,
  client: LoopMarshalClient,
): void {
  const run = async (operation: () => Promise<unknown> | unknown) => {
    try {
      console.log(
        JSON.stringify(
          { apiVersion: "1", data: (await operation()) ?? null },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            apiVersion: "1",
            error: controlErrorDetails(error),
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
  };
  const call = (name: string, input: unknown = {}) =>
    run(() => callControlAction(client, name, input));
  const inputOptions = (command: Command) =>
    command
      .option(
        "--input <json>",
        "JSON parameters; use a file for complex or sensitive input",
      )
      .option(
        "--input-file <path>",
        "UTF-8 JSON file, or - to read standard input",
      );
  const api = program
    .command("api")
    .description(
      "Discover and call LoopMarshal application capabilities (JSON output)",
    );
  api
    .command("actions")
    .option("--group <name>", "Filter by capability group")
    .action((o: { group?: string }) => run(() => listControlActions(o.group)));
  api
    .command("describe <action>")
    .description("Read an operation's JSON Schema before calling it")
    .action((name: string) => run(() => describeControlAction(name)));
  inputOptions(
    api
      .command("call <action>")
      .description("Call an operation using the same schema as MCP"),
  ).action((name: string, o: InputOptions) =>
    run(async () => callControlAction(client, name, await readControlInput(o))),
  );

  const sessions = program
    .command("session")
    .description("Create, inspect and talk to project collaborations");
  sessions
    .command("list")
    .option("--project <path>", "Filter active sessions by project directory")
    .action((o: { project?: string }) =>
      call("session.list", o.project ? { projectPath: o.project } : {}),
    );
  inputOptions(
    sessions
      .command("create")
      .description(
        "Create a full collaboration; see api describe session.create",
      ),
  ).action((o: InputOptions) =>
    run(async () =>
      callControlAction(client, "session.create", await readControlInput(o)),
    ),
  );
  sessions
    .command("get <name>")
    .action((session: string) => call("session.get", { session }));
  sessions
    .command("message <name>")
    .requiredOption("--content <text>", "Message to the Host")
    .requiredOption("--idempotency-key <key>", "Reuse this key when retrying")
    .action((session: string, o: { content: string; idempotencyKey: string }) =>
      call("session.message", { session, ...o }),
    );
  sessions
    .command("delete <name>")
    .action((session: string) => call("session.delete", { session }));
  program
    .command("model")
    .description("Manage saved model configurations")
    .command("list")
    .action(() => call("model.list"));
  const tool =
    program.commands.find((c) => c.name() === "tool") ??
    program.command("tool");
  tool
    .command("discover")
    .description("Discover local coding tools")
    .action(() => call("tool.discover"));
  tool
    .command("check <installation-id>")
    .option("--endpoint <url>")
    .action((installationId: string, o: { endpoint?: string }) =>
      call("tool.check", { installationId, ...o }),
    );
  program
    .command("discussion")
    .description("Query discussion rooms; other actions are under api call")
    .command("list")
    .action(() => call("discussion.list"));
}
