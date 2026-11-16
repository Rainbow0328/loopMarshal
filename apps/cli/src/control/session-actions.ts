import {
  createSessionSetupSchema,
  namedSendInputSchema,
  createProxyMemberInputSchema,
  updateMemberRouteInputSchema,
} from "@loopmarshal/protocol";
import { z } from "zod";
import { action, empty, sessionInput, text } from "./action.js";
import { ControlError } from "./errors.js";
import { isDeepStrictEqual } from "node:util";

const member = z.object({ session: text, agentId: text }).strict();

export const sessionActions = [
  action("app.status", "查询本机服务状态。", empty, (c) => c.getStatus()),
  action(
    "session.list",
    "列出活跃协作会话，可按项目目录筛选；统一返回 sessions、projectPath 和未关联项目的会话数量。",
    z.object({ projectPath: text.optional() }).strict(),
    (c, i) => c.discoverSessions(i),
  ),
  action(
    "session.create",
    "按项目创建完整协作，配置 Host、Worker、知识库维护者；代理工具默认创建新会话，无需已有原生会话编号。",
    createSessionSetupSchema,
    (c, i) => c.createSessionSetup(i),
    false,
  ),
  action(
    "session.get",
    "按名称查看会话、成员、执行状态和进展。",
    sessionInput,
    async (c, i) =>
      c.getSessionConsole((await c.getSessionByName(i.session)).id),
  ),
  action(
    "session.delete",
    "删除指定协作会话；不会删除项目代码。",
    sessionInput,
    (c, i) => c.deleteSessionByName(i.session),
    false,
  ),
  action(
    "session.message",
    "以用户身份给 Host 发消息；沿用界面对话流程和现有原生会话。重试须复用 idempotencyKey。",
    z
      .object({
        session: text,
        content: text.max(100000),
        idempotencyKey: text,
      })
      .strict(),
    async (c, i) => {
      const session = await c.getSessionByName(i.session);
      if (!session.hostAgentId) throw new Error("此会话没有 Host。");
      const payload = {
        kind: "web_user_message",
        content: i.content,
        source: "external_app",
      };
      const message = await c.sendMessage({
        sessionId: session.id,
        fromAgentId: session.hostAgentId,
        toAgentId: session.hostAgentId,
        type: "instruction",
        idempotencyKey: i.idempotencyKey,
        payload,
      });
      if (
        message.type !== "instruction" ||
        message.toAgentId !== session.hostAgentId ||
        !isDeepStrictEqual(message.payload, payload)
      )
        throw new ControlError(
          "CONFLICT",
          "此幂等键已用于其他消息，请为新的请求选择新的幂等键。",
        );
      return message;
    },
    false,
  ),
  action(
    "member.list",
    "查询会话中所有成员的接入方式与精确路由绑定。",
    sessionInput,
    async (c, i) =>
      c.listMemberRoutes((await c.getSessionByName(i.session)).id),
  ),
  action(
    "member.add_proxy",
    "接入一个已有原生会话作为 Worker 或知识库维护者。新建完整团队请用 session.create。",
    z.object({ session: text, member: createProxyMemberInputSchema }).strict(),
    async (c, i) =>
      c.createProxyMember((await c.getSessionByName(i.session)).id, i.member),
    false,
  ),
  action(
    "member.add_external",
    "为通过 MCP/CLI 等待任务的外部成员登记职责。",
    z
      .object({
        session: text,
        agentName: text,
        roleDescription: text,
        role: z.enum(["worker", "knowledge_keeper"]).optional(),
        accessMode: z.enum(["mcp_await", "cli_await"]),
      })
      .strict(),
    async (c, { session, ...input }) =>
      c.createAwaitMember((await c.getSessionByName(session)).id, input),
    false,
  ),
  action(
    "member.update_route",
    "更新成员绑定；必须提交当前 bindingVersion，防止覆盖较新的绑定。",
    member.extend({ route: updateMemberRouteInputSchema }),
    async (c, i) =>
      c.updateMemberRoute(
        (await c.getSessionByName(i.session)).id,
        i.agentId,
        i.route,
      ),
    false,
  ),
  action(
    "member.verify",
    "检查指定成员的原生会话绑定。",
    member.extend({ bindingVersion: z.number().int().positive() }),
    async (c, i) =>
      c.verifyMemberRoute(
        (await c.getSessionByName(i.session)).id,
        i.agentId,
        i.bindingVersion,
      ),
    false,
  ),
  action(
    "member.remove",
    "从指定协作中移除成员；Host 仍由核心服务保护。",
    member,
    async (c, i) => {
      const session = await c.getSessionByName(i.session);
      if (!session.hostAgentId) throw new Error("此会话没有 Host。");
      return c.removeSessionMember({
        sessionId: session.id,
        requesterAgentId: session.hostAgentId,
        targetAgentId: i.agentId,
      });
    },
    false,
  ),
  action(
    "member.refresh_setup",
    "重新生成会话成员需要的协作 MCP 与 Skill 配置。",
    sessionInput,
    async (c, i) =>
      c.refreshAgentSetups((await c.getSessionByName(i.session)).id),
    false,
  ),
  action(
    "message.send",
    "按会话和成员名称发送任务、回报或普通消息。接收端沿用已登记的工具和会话；重试复用幂等键。",
    namedSendInputSchema,
    (c, i) => c.sendByName(i),
    false,
  ),
  action(
    "message.query",
    "分页查询已记录的协作消息，不领取、不消费消息。",
    sessionInput.extend({
      memberName: text.optional(),
      correlationId: text.optional(),
      beforeMessageId: text.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async (c, { session: name, ...args }) => {
      const session = await c.getSessionByName(name);
      if (!session.hostAgentId) throw new Error("此会话没有 Host。");
      const result = await c.callMcpTool({
        sessionId: session.id,
        agentId: session.hostAgentId,
        toolName: "query_messages",
        arguments: args,
      });
      if (!result.success) throw new Error(result.error ?? "消息查询失败。");
      return result.result;
    },
  ),
  action(
    "delivery.list",
    "查询原生工具任务的投递与执行状态。",
    sessionInput,
    async (c, i) => c.listDeliveries((await c.getSessionByName(i.session)).id),
  ),
  action(
    "delivery.events",
    "按序号读取某次执行的增量输出事件。",
    z.object({ id: text, after: z.number().int().min(0).default(0) }).strict(),
    (c, i) => c.getDeliveryEvents(i.id, i.after),
  ),
  action(
    "delivery.cancel",
    "停止指定的原生工具执行。",
    z.object({ id: text }).strict(),
    (c, i) => c.cancelDelivery(i.id),
    false,
  ),
  action(
    "delivery.reconcile",
    "核对中断执行的最终状态，要求确认原执行已经停止。",
    z
      .object({
        id: text,
        outcome: z.enum(["reported", "failed"]),
        summary: text,
        confirmedStopped: z.literal(true),
      })
      .strict(),
    (c, { id, ...input }) => c.reconcileDelivery(id, input),
    false,
  ),
];
