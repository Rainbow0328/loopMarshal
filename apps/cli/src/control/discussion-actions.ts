import { z } from "zod";
import { action, empty, text, strings } from "./action.js";

const room = z.object({ roomId: text }).strict();

export const discussionActions = [
  action("discussion.list", "列出讨论室和参与成员。", empty, (c) =>
    c.listDiscussions(),
  ),
  action(
    "discussion.create",
    "创建由已配置模型或编程工具参加的讨论室。",
    z
      .object({
        name: text.max(120),
        modelIds: strings.default([]),
        cliMembers: z
          .array(
            z
              .object({
                installationId: text,
                runtimeNamespace: text.optional(),
              })
              .strict(),
          )
          .max(8)
          .default([]),
      })
      .strict(),
    (c, i) => c.createDiscussion(i),
    false,
  ),
  action(
    "discussion.messages",
    "分页读取讨论室历史；before 是上一页最早的消息编号。",
    room.extend({
      before: text.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    (c, i) => c.listDiscussionMessages(i.roomId, i.before, i.limit),
  ),
  action(
    "discussion.send",
    "向指定讨论室成员提问，等待本轮回复；可能耗时，勿重复投递。",
    room.extend({ content: text.max(100000), memberIds: strings.min(1) }),
    (c, { roomId, ...i }) => c.sendDiscussionMessage(roomId, i),
    false,
  ),
  action(
    "discussion.stop",
    "停止讨论室当前回复。",
    room,
    (c, i) => c.stopDiscussion(i.roomId),
    false,
  ),
  action(
    "discussion.knowledge.list",
    "列出此讨论室经整理保存的知识，不加载完整聊天历史。",
    room,
    (c, i) => c.listDiscussionKnowledge(i.roomId),
  ),
  action(
    "discussion.knowledge.draft",
    "用选定模型和消息生成知识草稿；不直接入库。",
    room.extend({ modelId: text, sourceIds: strings.min(1) }),
    (c, { roomId, ...i }) => c.draftDiscussionKnowledge(roomId, i),
    false,
  ),
  action(
    "discussion.knowledge.save",
    "保存已整理的讨论室知识，并保留原始消息引用。",
    room.extend({ title: text, content: text, sourceIds: strings.min(1) }),
    (c, { roomId, ...i }) => c.saveDiscussionKnowledge(roomId, i),
    false,
  ),
  action(
    "discussion.knowledge.sources",
    "按需获取知识引用的原消息，避免将整个讨论室上下文注入任务会话。",
    room.extend({ entryId: text }),
    (c, i) => c.getDiscussionKnowledgeSources(i.roomId, i.entryId),
  ),
  action(
    "discussion.access.list",
    "查询某协作会话获准读取的讨论室。",
    z.object({ session: text }).strict(),
    async (c, i) =>
      c.getDiscussionGrants((await c.getSessionByName(i.session)).id),
  ),
  action(
    "discussion.access.set",
    "允许或撤销某协作会话对讨论室知识的读取。",
    room.extend({ session: text, enabled: z.boolean() }),
    async (c, i) =>
      c.setDiscussionGrant(
        (await c.getSessionByName(i.session)).id,
        i.roomId,
        i.enabled,
      ),
    false,
  ),
];
