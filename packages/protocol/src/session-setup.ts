import { z } from "zod";
import { nativeSessionBindingDraftSchema } from "./member-routes.js";
import type { MemberAccessMode } from "./member-routes.js";
import type { Agent, SessionSummary } from "./types.js";

export const sessionAgentSetupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.enum(["host", "worker", "knowledge_keeper"]),
    duty: z.string().trim().min(1).max(4000),
    mode: z.enum(["core_runtime", "managed_proxy", "mcp_await", "cli_await"]),
    /** Defaults to creating a new native session when no ID is supplied. */
    nativeSessionMode: z.enum(["create", "existing"]).optional(),
    modelConfigId: z.string().optional(),
    externalMcpServerIds: z.array(z.string()).max(20).default([]),
    customSkillIds: z.array(z.string()).max(20).default([]),
    binding: nativeSessionBindingDraftSchema.optional(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    if (
      agent.role === "host" &&
      !["core_runtime", "managed_proxy"].includes(agent.mode)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "在客户端创建会话时，Host 必须选择本地模型或代理 CLI 工具。外部 Host 请通过扫描会话打开。",
      });
    if (agent.mode === "core_runtime" && !agent.modelConfigId?.trim())
      ctx.addIssue({ code: "custom", message: "请选择本地模型配置。" });
    if (agent.mode === "managed_proxy" && !agent.binding)
      ctx.addIssue({ code: "custom", message: "请选择要使用的编程工具。" });
    const nativeSessionMode =
      agent.nativeSessionMode ??
      (agent.binding?.nativeSessionId ? "existing" : "create");
    if (
      agent.mode === "managed_proxy" &&
      nativeSessionMode === "existing" &&
      !agent.binding?.nativeSessionId?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "nativeSessionId"],
        message: "接入已有会话时请填写原生会话编号。",
      });
    }
  });
export const createSessionSetupSchema = z
  .object({
    sessionName: z.string().trim().min(1).max(120),
    projectPath: z.string().trim().min(1),
    agents: z.array(sessionAgentSetupSchema).min(1).max(24),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.agents.filter((a) => a.role === "host").length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "每个会话需要且仅能有一个 Host。",
      });
    if (input.agents.filter((a) => a.role === "knowledge_keeper").length > 1)
      ctx.addIssue({
        code: "custom",
        message: "每个会话至多配置一个知识库维护者。",
      });
    if (new Set(input.agents.map((a) => a.name)).size !== input.agents.length)
      ctx.addIssue({ code: "custom", message: "成员名称不能重复。" });
  });
export type SessionAgentSetup = z.input<typeof sessionAgentSetupSchema>;
export type CreateSessionSetupInput = z.input<typeof createSessionSetupSchema>;

export const discoverSessionsInputSchema = z
  .object({ projectPath: z.string().trim().min(1).optional() })
  .strict();
export type DiscoverSessionsInput = z.input<typeof discoverSessionsInputSchema>;
export type DiscoveredSession = SessionSummary & {
  host: Pick<Agent, "id" | "agentName" | "displayName" | "platform"> & {
    accessMode: MemberAccessMode;
  };
};
export type DiscoverSessionsResult = {
  sessions: DiscoveredSession[];
  projectPath: string | null;
  unassignedSessionCount: number;
};

export type ManagedAgentSetup = {
  sessionId: string;
  agentId: string;
  role: "host" | "worker" | "knowledge_keeper";
  accessMode: MemberAccessMode;
  status: "ready";
  skillVersion: number;
  serverName: string;
  skillPath: string;
  mcpConfigPath: string;
  bridgePath: string;
  transport: "in_process" | "native_mcp" | "command_bridge" | "external_mcp";
  tools: string[];
};
