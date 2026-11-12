import type { ProxyToolId } from "./member-routes.js";

export type ToolCompatibilityIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  action?: string;
};
export type ToolAvailability = {
  status: "available" | "setup_required" | "unavailable";
  reason?: string;
  action?: string;
};
export type ToolCheckResult = {
  availability: ToolAvailability;
  checkedAt: string;
  version: string | null;
};
export type ToolCompatibility = {
  status: "verified" | "limited" | "experimental" | "unavailable";
  label: string;
  summary: string;
  issues: ToolCompatibilityIssue[];
};

/** User-facing readiness is independent of internal acceptance evidence. */
export function toolAvailability(
  compatibility: ToolCompatibility,
  endpoint?: string | null,
  scope: "installation" | "session" = "installation",
): ToolAvailability {
  if (compatibility.status === "unavailable") {
    const issue = compatibility.issues.find(
      (item) => item.severity === "error",
    );
    return {
      status: "unavailable",
      reason: issue?.message ?? compatibility.summary,
      ...(issue?.action ? { action: issue.action } : {}),
    };
  }
  const issue = compatibility.issues.find(
    (item) =>
      (item.code === "server_required" &&
        scope === "session" &&
        !endpoint?.trim()) ||
      item.code === "qwen_bare" ||
      item.code === "kimi_unsupported_version",
  );
  if (issue)
    return {
      status: "setup_required",
      reason: issue.message,
      ...(issue.action ? { action: issue.action } : {}),
    };
  return { status: "available" };
}
export const toolNames: Record<ProxyToolId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  mimo: "MiMo Code",
  zcode: "ZCode",
  qwen: "Qwen Code",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  kimi: "Kimi Code CLI",
  cursor: "Cursor CLI",
  droid: "Factory Droid",
  copilot: "GitHub Copilot CLI",
};
export const toolDescriptions: Record<ProxyToolId, string> = {
  codex: "OpenAI 的终端 Worker",
  claude: "Anthropic 的终端 Worker",
  mimo: "小米 MiMo 的终端 Worker",
  zcode: "智谱 ZCode 的终端 Worker",
  qwen: "通义的终端 Worker",
  opencode: "开源终端 Worker",
  gemini: "Google 的终端 Worker",
  kimi: "月之暗面的终端 Worker",
  cursor: "Cursor 的命令行 Worker",
  droid: "Factory 的终端 Worker",
  copilot: "GitHub 的终端 Worker",
};
/** Product evidence is version-specific; discovery alone never proves compatibility. */
export function toolCompatibility(
  tool: ProxyToolId,
  version: string | null = null,
  args: readonly string[] = [],
): ToolCompatibility {
  const verified = {
    codex: "0.153.4",
    claude: "2.1.278",
    mimo: "0.1.16",
  } as Partial<Record<ProxyToolId, string>>;
  const issues: ToolCompatibilityIssue[] = [];
  const experimental = [
    "gemini",
    "kimi",
    "cursor",
    "droid",
    "copilot",
  ].includes(tool);
  if (experimental)
    issues.push({
      code: "model_acceptance_pending",
      severity: "warning",
      message:
        tool === "cursor"
          ? "已提供代理适配，当前尚未完成 Cursor 账号登录后的会话与模型验收。"
          : "已用官方程序和本地测试服务验证定向发送与历史接续，真实模型协作尚未验收。",
      action: "先用小任务确认登录、任务执行、历史接续和回报。",
    });
  else if (!verified[tool])
    issues.push({
      code: "routing_only",
      severity: "warning",
      message: "已验证官方程序的定向会话路由，真实模型协作尚未验收。",
    });
  if (
    verified[tool] &&
    (!version ||
      !new RegExp(
        `(^|[^\\d])${verified[tool]!.replace(/\./g, "\\.")}([^\\d]|$)`,
      ).test(version))
  ) {
    issues.push({
      code: "version_not_verified",
      severity: "warning",
      message: `已验收版本为 ${verified[tool]}；${version ? "当前登记版本尚未验收" : "当前版本尚未确认"}，不代表工具不可用。`,
    });
  }
  if (["mimo", "opencode"].includes(tool))
    issues.push({
      code: "server_required",
      severity: "warning",
      message: "接入前需要配置本机会话服务。",
      action: "先启动该工具的会话服务，再在创建协作或成员接入时填写服务地址。",
    });
  if (
    tool === "qwen" &&
    /(?:^|[^\d])0\.27\.0(?:[^\d]|$)/.test(version ?? "") &&
    !args.includes("--bare")
  )
    issues.push({
      code: "qwen_bare",
      severity: "warning",
      message: "此版本需要调整启动参数，避免任务完成后崩溃。",
      action: "在安装设置的启动参数中加入 --bare。",
    });
  if (
    tool === "kimi" &&
    /(?:^|[^\d])1\.\d+(?:\.\d+)?(?:[^\d]|$)/.test(version ?? "")
  )
    issues.push({
      code: "kimi_unsupported_version",
      severity: "warning",
      message: "当前为旧版 Kimi CLI，无法接入。",
      action: "安装 Kimi Code CLI 2.x 后重新发现 Worker。",
    });
  if (tool === "kimi")
    issues.push(
      {
        code: "kimi_v2_required",
        severity: "warning",
        message:
          "适配新版 Kimi Code CLI 2.x，数据目录为 .kimi-code；旧 Python kimi-cli 1.52 已停止执行任务，不兼容。",
        action: "请安装新版 Kimi Code CLI；旧版历史需使用官方迁移功能。",
      },
      {
        code: "kimi_history_guard",
        severity: "info",
        message:
          "每次续接前校验原生历史，缺失时停止发送。权限批准沿用官方配置，未自动批准全部操作。",
      },
    );
  if (tool === "cursor")
    issues.push(
      {
        code: "cursor_cli_only",
        severity: "info",
        message:
          "接入的是 Cursor CLI。不能向 IDE 中任意已打开的聊天注入消息；已有会话导入暂不支持，请在此新建。",
      },
      {
        code: "cursor_auth",
        severity: "info",
        message:
          "登录与模型由 Cursor 管理，不提供通用 API 地址和模型密钥替换。",
      },
    );
  if (tool === "droid")
    issues.push({
      code: "droid_permissions",
      severity: "warning",
      message:
        "默认使用厂商的只读执行权限；开发任务需在安装设置中明确配置所需的 --auto 权限级别。",
    });
  if (tool === "copilot")
    issues.push({
      code: "copilot_auth",
      severity: "info",
      message:
        "需要官方账号授权或自带模型服务配置；模型可编辑，令牌与自定义服务认证由官方登录或明确选择的环境变量管理。",
    });
  const status = experimental
    ? "experimental"
    : issues.some((issue) => issue.severity === "warning")
      ? "limited"
      : "verified";
  // Put actionable requirements before acceptance notes in collapsed lists.
  const priority = [
    "server_required",
    "qwen_bare",
    "kimi_v2_required",
    "droid_permissions",
    "version_not_verified",
    "model_acceptance_pending",
    "routing_only",
  ];
  issues.sort((a, b) => {
    const rank = (code: string) =>
      priority.includes(code) ? priority.indexOf(code) : priority.length;
    return rank(a.code) - rank(b.code);
  });
  const requirementLabels: Record<string, string> = {
    server_required: "需启动本地服务",
    qwen_bare: "需调整启动参数",
    kimi_v2_required: "需使用新版 CLI",
    droid_permissions: "需配置执行权限",
    version_not_verified: "版本待验收",
    model_acceptance_pending: "模型协作待验收",
    routing_only: "模型协作待验收",
  };
  return {
    status,
    label:
      status === "verified"
        ? "已验收"
        : (requirementLabels[issues[0]?.code ?? ""] ?? "存在兼容限制"),
    summary: experimental
      ? "已提供接入适配，真实模型协作仍需验证。"
      : "按成员绑定定向发送，并接续同一个原生会话。",
    issues,
  };
}
