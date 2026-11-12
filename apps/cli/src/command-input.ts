import {
  knowledgeSourceKinds,
  type KnowledgeLevel,
  type KnowledgeSourceKind,
  type MessageType,
} from "@loopmarshal/protocol";
import { SUPPORTED_MESSAGE_TYPES } from "./constants.js";

export const parseListOption = (value: string, previous: string[]) => {
  previous.push(value);
  return previous;
};

export const parseTagsOption = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
};

export const ensureKnowledgeLevel = (
  value: string | undefined,
): KnowledgeLevel => {
  if (value === "l1" || value === "l2" || value === "l3") {
    return value;
  }
  throw new Error("knowledge level 必须是 l1、l2 或 l3。");
};

export const ensureKnowledgeSourceKind = (
  value: string | undefined,
): KnowledgeSourceKind => {
  const normalized = value ?? "host_update";
  if ((knowledgeSourceKinds as readonly string[]).includes(normalized)) {
    return normalized as KnowledgeSourceKind;
  }
  throw new Error(
    `knowledge source-kind 必须是 ${knowledgeSourceKinds.join("、")} 之一。`,
  );
};

export const parseKnowledgeRef = (
  ref: string,
): {
  level: KnowledgeLevel;
  slug: string;
  fragment: string | null;
} => {
  const [pathPart, fragment] = ref.split("#", 2);
  const normalized = (pathPart ?? "")
    .replace(/^knowledge:/i, "")
    .replace(/^\/+/, "");
  const [level, ...slugParts] = normalized.split("/");
  if (slugParts.length === 0) {
    throw new Error(
      `知识库引用 "${ref}" 无效，应形如 L1/session-direction 或 l2/cli-flow#section。`,
    );
  }
  return {
    level: ensureKnowledgeLevel(level?.toLowerCase()),
    slug: slugParts.join("/"),
    fragment: fragment ?? null,
  };
};

export type WindowDispatchTaskSpec = {
  targetWindowName: string;
  content: string;
};

export const parseWindowDispatchTaskSpec = (
  rawValue: string,
): WindowDispatchTaskSpec => {
  const value = rawValue.trim();
  if (!value) {
    throw new Error(
      '批量派发任务不能为空。请使用 --task "<workerWindow>::<任务内容>"。',
    );
  }

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const targetWindowName =
        typeof parsed.to === "string"
          ? parsed.to.trim()
          : typeof parsed.windowName === "string"
            ? parsed.windowName.trim()
            : typeof parsed.workerWindow === "string"
              ? parsed.workerWindow.trim()
              : "";
      const content =
        typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (targetWindowName && content) {
        return {
          targetWindowName,
          content,
        };
      }
    } catch (error: unknown) {
      throw new Error(
        `无法解析批量派发任务 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    throw new Error(
      "批量派发任务 JSON 必须包含 to/windowName/workerWindow 之一，以及 content。",
    );
  }

  for (const separator of ["::", "=>", "="]) {
    const index = value.indexOf(separator);
    if (index <= 0) {
      continue;
    }

    const targetWindowName = value.slice(0, index).trim();
    const content = value.slice(index + separator.length).trim();
    if (targetWindowName && content) {
      return {
        targetWindowName,
        content,
      };
    }
  }

  throw new Error(
    '批量派发任务格式无效。请使用 --task "<workerWindow>::<任务内容>"，或传入包含 to 和 content 的 JSON。',
  );
};

const buildMergedDispatchTaskContent = (contents: string[]) => {
  if (contents.length === 1) {
    return contents[0]!;
  }

  return contents
    .map((content, index) => `任务 ${index + 1}\n${content}`)
    .join("\n\n---\n\n");
};

export const normalizeWindowDispatchTasks = (
  rawTasks: WindowDispatchTaskSpec[],
): WindowDispatchTaskSpec[] => {
  const grouped = new Map<string, string[]>();

  for (const task of rawTasks) {
    const existing = grouped.get(task.targetWindowName) ?? [];
    existing.push(task.content.trim());
    grouped.set(task.targetWindowName, existing);
  }

  return Array.from(grouped.entries()).map(([targetWindowName, contents]) => ({
    targetWindowName,
    content: buildMergedDispatchTaskContent(
      contents.filter((value) => value.length > 0),
    ),
  }));
};

export const resolveWorkerRoleDescription = (
  role: "worker" | "observer",
  roleDescription: string | undefined,
  optionName: string,
): string | undefined => {
  const normalized = roleDescription?.trim();
  if (role !== "worker") {
    return normalized || undefined;
  }

  if (!normalized) {
    throw new Error(
      `当前 worker 加入必须提供角色说明。请通过 ${optionName} \"<说明>\" 告诉系统这个 worker 是干什么用的。`,
    );
  }

  return normalized;
};

export const ensureMessageType = (value: string): MessageType => {
  if (SUPPORTED_MESSAGE_TYPES.includes(value as MessageType)) {
    return value as MessageType;
  }

  throw new Error(
    `不支持的消息类型 "${value}"，可选值：${SUPPORTED_MESSAGE_TYPES.join(", ")}`,
  );
};
