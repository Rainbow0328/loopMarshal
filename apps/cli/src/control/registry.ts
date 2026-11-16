import type { LoopMarshalClient } from "@loopmarshal/sdk";
import { assertControlAccess } from "./access.js";
import { ControlError } from "./errors.js";
import { discussionActions } from "./discussion-actions.js";
import { knowledgeActions } from "./knowledge-actions.js";
import { modelActions } from "./model-actions.js";
import { toolActions } from "./tool-actions.js";
import { integrationActions } from "./integration-actions.js";
import { runtimeActions } from "./runtime-actions.js";
import { sessionActions } from "./session-actions.js";

const actions = [
  ...sessionActions,
  ...modelActions,
  ...toolActions,
  ...integrationActions,
  ...runtimeActions,
  ...discussionActions,
  ...knowledgeActions,
];
const byName = new Map(actions.map((a) => [a.name, a]));
if (byName.size !== actions.length)
  throw new Error("Duplicate control action name.");

function requireAction(name: string) {
  const action = byName.get(name);
  if (!action)
    throw new ControlError(
      "ACTION_NOT_FOUND",
      "未知操作，请使用 api actions 查询支持的操作。",
    );
  return action;
}

export function listControlActions(group?: string) {
  return actions
    .filter((a) => !group || a.group === group)
    .map(({ name, group, description, readOnly }) => ({
      name,
      group,
      description,
      readOnly,
    }));
}

export function describeControlAction(name: string) {
  const {
    name: actionName,
    group,
    description,
    readOnly,
    inputSchema,
  } = requireAction(name);
  return { name: actionName, group, description, readOnly, inputSchema };
}

export async function callControlAction(
  client: LoopMarshalClient,
  name: string,
  input: unknown = {},
) {
  assertControlAccess();
  return requireAction(name).execute(client, input);
}
