import {
  createToolInstallationInputSchema,
  updateToolInstallationInputSchema,
  createToolConfigProfileSchema,
  previewToolConfigSchema,
  toolInstallRequestSchema,
} from "@loopmarshal/protocol";
import { z } from "zod";
import { action, empty, text } from "./action.js";

const profile = z.object({ profileId: text }).strict();

export const toolActions = [
  action(
    "tool.list",
    "列出已登记的编程工具、兼容性和安装目录；可用性用 tool.check 核实。",
    empty,
    (c) => c.listToolInstallations(),
  ),
  action(
    "tool.discover",
    "扫描本机编程工具并返回候选项；不会自动登记、安装或改写配置。",
    empty,
    (c) => c.discoverTools(),
  ),
  action(
    "tool.check",
    "检查已登记编程工具是否可用，返回问题原因和处理建议。",
    z
      .object({ installationId: text, endpoint: z.string().url().optional() })
      .strict(),
    (c, i) =>
      c.checkToolInstallation(
        i.installationId,
        i.endpoint ? { endpoint: i.endpoint } : {},
      ),
  ),
  action(
    "tool.register",
    "登记本机已有的编程工具；不下载软件。",
    createToolInstallationInputSchema,
    (c, i) => c.createToolInstallation(i),
    false,
  ),
  action(
    "tool.update",
    "更新已登记工具的路径、启动参数和环境变量名称。",
    z
      .object({
        installationId: text,
        settings: updateToolInstallationInputSchema,
      })
      .strict(),
    (c, i) => c.updateToolInstallation(i.installationId, i.settings),
    false,
  ),
  action(
    "tool.sessions",
    "按项目和配置目录发现工具的已有原生会话。",
    z
      .object({
        installationId: text,
        workspacePath: text,
        runtimeNamespace: z.string().optional(),
      })
      .strict(),
    (c, { installationId, ...i }) =>
      c.discoverNativeSessions(installationId, i),
  ),
  action(
    "tool.config.list",
    "列出已登记工具的配置档案及配置目录。",
    empty,
    (c) => c.listToolConfigProfiles(),
  ),
  action(
    "tool.config.create",
    "为工具登记配置目录；支持将配置放在用户指定磁盘。",
    createToolConfigProfileSchema,
    (c, i) => c.createToolConfigProfile(i),
    false,
  ),
  action(
    "tool.config.read",
    "读取配置项与文件指纹；密钥字段保持遮蔽。",
    profile,
    (c, i) => c.getToolConfigDocuments(i.profileId),
  ),
  action(
    "tool.config.preview",
    "预览配置更改，需要当前文件指纹；尚不写入文件。",
    profile.extend({ changes: previewToolConfigSchema }),
    (c, i) => c.previewToolConfig(i.profileId, i.changes),
    false,
  ),
  action(
    "tool.config.model_preview",
    "将已有模型转换为目标工具的配置预览，遵循协议兼容性检查。",
    profile.extend({
      modelId: text,
      expectedFingerprint: text,
      responsesConfirmed: z.boolean().optional(),
    }),
    (c, { profileId, ...i }) => c.previewToolModel(profileId, i),
    false,
  ),
  action(
    "tool.config.apply",
    "应用预览并自动备份原配置；必须使用未过期的 previewId。",
    profile.extend({ previewId: text }),
    (c, i) => c.applyToolConfig(i.profileId, i.previewId),
    false,
  ),
  action("tool.config.backups", "查询配置备份。", profile, (c, i) =>
    c.getToolConfigBackups(i.profileId),
  ),
  action(
    "tool.config.restore",
    "从指定备份恢复工具配置。",
    profile.extend({ backupId: text }),
    (c, i) => c.restoreToolConfig(i.profileId, i.backupId),
    false,
  ),
  action(
    "tool.install.catalog",
    "查询可安装工具、安装进度和默认安装根目录。",
    empty,
    (c) => c.getToolInstaller(),
  ),
  action(
    "tool.install.root",
    "设置后续工具安装与配置缓存的默认根目录。",
    z.object({ root: text }).strict(),
    (c, i) => c.saveToolInstallRoot(i.root),
    false,
  ),
  action(
    "tool.install.start",
    "按官方目录安装编程工具，立即返回任务 id；用 tool.install.catalog 查询进展。",
    toolInstallRequestSchema,
    (c, i) => c.startToolInstall(i),
    false,
  ),
];
