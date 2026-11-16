import type { LoopMarshalClient } from "@loopmarshal/sdk";
import { z } from "zod";
import { assertControlAccess } from "./access.js";
import { parseControlInput } from "./errors.js";
import {
  callControlAction,
  describeControlAction,
  listControlActions,
} from "./registry.js";

export type StdioToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean; openWorldHint: boolean };
};

const shortcuts: Record<string, string> = {
  session_list: "session.list",
  session_create: "session.create",
  session_get: "session.get",
  session_message: "session.message",
  model_list: "model.list",
  tool_list: "tool.list",
  tool_discover: "tool.discover",
  tool_check: "tool.check",
  discussion_list: "discussion.list",
};
const capabilitiesInput = z.object({ group: z.string().optional() }).strict();
const describeInput = z.object({ action: z.string().min(1) }).strict();
const callInput = z
  .object({
    action: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  })
  .strict();
const directoryTools: StdioToolDefinition[] = [
  {
    name: "app_capabilities",
    description:
      "Discover LoopMarshal application actions by group. No member attachment is required. Read the schema with app_describe before app_call. Includes sessions, tools/config/install, models, runtimes, knowledge and discussions.",
    inputSchema: {
      type: "object",
      properties: { group: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "app_describe",
    description:
      "Read one application action's exact input JSON Schema and whether it writes data. Use this before calling an unfamiliar action.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "app_call",
    description:
      "Call a discovered LoopMarshal application action. Supply the exact action name and input from app_describe. Uses the same service/validation as the desktop app. Configuration writes use preview/apply; this tool may modify data or run a model/tool, depending on the selected action.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        input: { type: "object", additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

export const controlMcpTools: StdioToolDefinition[] = [
  ...directoryTools,
  ...Object.entries(shortcuts).map(([name, operation]) => {
    const a = describeControlAction(operation);
    return {
      name,
      description: a.description,
      inputSchema: a.inputSchema,
      annotations: { readOnlyHint: a.readOnly, openWorldHint: !a.readOnly },
    };
  }),
];
const names = new Set(controlMcpTools.map((t) => t.name));
export function isControlMcpTool(name: string): boolean {
  return names.has(name);
}

export async function callControlMcpTool(
  client: LoopMarshalClient,
  name: string,
  args: unknown,
) {
  assertControlAccess();
  if (name === "app_capabilities") {
    const input = parseControlInput(capabilitiesInput, args);
    return { apiVersion: "1", actions: listControlActions(input.group) };
  }
  if (name === "app_describe") {
    const input = parseControlInput(describeInput, args);
    return { apiVersion: "1", ...describeControlAction(input.action) };
  }
  if (name === "app_call") {
    const input = parseControlInput(callInput, args);
    return {
      apiVersion: "1",
      data:
        (await callControlAction(client, input.action, input.input)) ?? null,
    };
  }
  const operation = shortcuts[name];
  if (!operation) throw new Error(`Unknown application tool: ${name}`);
  return {
    apiVersion: "1",
    data: (await callControlAction(client, operation, args)) ?? null,
  };
}
