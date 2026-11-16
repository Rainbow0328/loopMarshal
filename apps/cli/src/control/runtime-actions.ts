import { z } from "zod";
import { action, sessionInput, strings, text } from "./action.js";

export const runtimeActions = [
  action(
    "runtime.configure",
    "修改本地模型 Agent 的模型、职责、Skill 与外部 MCP 服务。启停请用 runtime.start/stop/pause。",
    z
      .object({
        id: text,
        modelConfigId: text.optional(),
        customDuty: z.string().nullable().optional(),
        customSkillIds: strings.optional(),
        externalMcpServerIds: strings.optional(),
      })
      .strict(),
    (c, { id, ...i }) => c.updateWebAgentRuntime(id, i),
    false,
  ),
  action(
    "runtime.list",
    "列出会话中的本地模型 Agent。",
    sessionInput,
    async (c, i) =>
      c.listWebAgentRuntimes((await c.getSessionByName(i.session)).id),
  ),
  ...(["start", "stop", "pause"] as const).map((command) =>
    action(
      `runtime.${command}`,
      `对本地模型 Agent 执行 ${command}。`,
      z.object({ id: text }).strict(),
      (c, i) =>
        command === "start"
          ? c.startWebAgentRuntime(i.id)
          : command === "stop"
            ? c.stopWebAgentRuntime(i.id)
            : c.pauseWebAgentRuntime(i.id),
      false,
    ),
  ),
];
