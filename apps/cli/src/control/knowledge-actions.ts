import { z } from "zod";
import { action, sessionInput, strings, text } from "./action.js";

const level = z.enum(["l1", "l2", "l3"]);
const document = sessionInput.extend({ level, slug: text });

export const knowledgeActions = [
  action(
    "knowledge.list",
    "按会话、层级和关键词查询项目知识库。",
    sessionInput.extend({
      level: level.optional(),
      query: text.optional(),
      tag: text.optional(),
    }),
    async (c, { session, ...i }) =>
      c.listKnowledge({
        sessionId: (await c.getSessionByName(session)).id,
        ...i,
      }),
  ),
  action(
    "knowledge.read",
    "读取当前会话的指定知识文档。",
    document,
    async (c, i) =>
      c.getKnowledge(i.level, i.slug, (await c.getSessionByName(i.session)).id),
  ),
  action(
    "knowledge.upsert",
    "新增或更新会话知识；L1 为确认的方向，L2 为领域规则，L3 为数据契约。",
    document.extend({
      title: text,
      content: text,
      summary: z.string().optional(),
      tags: strings.optional(),
      changeSummary: text.optional(),
    }),
    async (c, { session, ...i }) =>
      c.upsertKnowledge({
        sessionId: (await c.getSessionByName(session)).id,
        sourceKind: "manual",
        ...i,
      }),
    false,
  ),
  action(
    "knowledge.delete",
    "删除当前会话中的指定知识文档。",
    document,
    async (c, { session, ...i }) =>
      c.deleteKnowledge({
        sessionId: (await c.getSessionByName(session)).id,
        sourceKind: "manual",
        ...i,
      }),
    false,
  ),
  action(
    "knowledge.changes",
    "查询当前会话的知识变更记录。",
    sessionInput.extend({
      level: level.optional(),
      slug: text.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async (c, { session, ...i }) =>
      c.listKnowledgeChanges({
        sessionId: (await c.getSessionByName(session)).id,
        ...i,
      }),
  ),
];
