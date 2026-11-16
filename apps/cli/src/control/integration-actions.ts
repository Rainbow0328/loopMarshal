import { z } from "zod";
import { action, empty, text } from "./action.js";

export const integrationActions = [
  action(
    "mcp.list",
    "查询已配置的外部 MCP 服务；不返回认证请求头。",
    empty,
    async (c) =>
      (await c.listMcpServers()).map(
        ({ id, name, description, transport, enabled, toolCount }) => ({
          id,
          name,
          description,
          transport,
          enabled,
          toolCount,
        }),
      ),
  ),
  action(
    "mcp.tools",
    "查询某个外部 MCP 服务提供的工具。",
    z.object({ serverId: text }).strict(),
    (c, i) => c.listMcpServerTools(i.serverId),
  ),
  action(
    "mcp.create",
    "登记外部 SSE MCP 服务，认证请求头只写入配置，不在结果中返回。",
    z
      .object({
        name: text,
        url: z.string().url(),
        description: z.string().optional(),
        headers: z.record(z.string().max(8192)).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    async (c, i) => {
      const saved = await c.createMcpServer({
        name: i.name,
        url: i.url,
        transport: "sse",
        ...(i.description !== undefined ? { description: i.description } : {}),
        ...(i.headers !== undefined ? { headers: i.headers } : {}),
        ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
      });
      return { id: saved.id, name: saved.name, enabled: saved.enabled };
    },
    false,
  ),
  action(
    "mcp.update",
    "更新外部 MCP 服务地址、说明或启用状态；不返回认证信息。",
    z
      .object({
        serverId: text,
        name: text.optional(),
        url: z.string().url().optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    async (c, i) => {
      const saved = await c.updateMcpServer(i.serverId, {
        ...(i.name !== undefined ? { name: i.name } : {}),
        ...(i.url !== undefined ? { url: i.url } : {}),
        ...(i.description !== undefined ? { description: i.description } : {}),
        ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
      });
      return { id: saved.id, name: saved.name, enabled: saved.enabled };
    },
    false,
  ),
  action(
    "mcp.delete",
    "删除外部 MCP 服务登记。",
    z.object({ serverId: text }).strict(),
    async (c, i) => {
      await c.deleteMcpServer(i.serverId);
      return { deleted: true };
    },
    false,
  ),
  action(
    "preference.list",
    "查询跨会话工作习惯，可按类别和关键词筛选。",
    z.object({ category: text.optional(), query: text.optional() }).strict(),
    (c, i) => c.listUserPreferences(i),
  ),
  action(
    "preference.save",
    "新增或更新跨会话工作习惯。",
    z.object({ key: text, value: text, category: text.optional() }).strict(),
    (c, i) =>
      c.upsertUserPreference(i.key, {
        value: i.value,
        source: "manual",
        ...(i.category ? { category: i.category } : {}),
      }),
    false,
  ),
  action(
    "preference.delete",
    "删除指定的跨会话工作习惯。",
    z.object({ key: text }).strict(),
    (c, i) => c.deleteUserPreference(i.key),
    false,
  ),
  action(
    "skill.list",
    "查询此构建实际开放的自定义 Skill；未启用时返回空列表。",
    empty,
    (c) => c.listSkills(),
  ),
  action(
    "workflow.list",
    "查询可给本地 Agent 使用的流程与角色模板。",
    empty,
    (c) => c.listWorkflows(),
  ),
];
