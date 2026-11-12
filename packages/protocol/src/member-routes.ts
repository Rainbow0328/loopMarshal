import { z } from "zod";
import type { Agent } from "./types.js";

export const proxyToolIds = [
  "codex",
  "claude",
  "mimo",
  "zcode",
  "qwen",
  "opencode",
  "gemini",
  "kimi",
  "cursor",
  "droid",
  "copilot",
] as const;
export type ProxyToolId = (typeof proxyToolIds)[number];
export const memberAccessModes = [
  "managed_proxy",
  "mcp_await",
  "cli_await",
  "core_runtime",
] as const;
export type MemberAccessMode = (typeof memberAccessModes)[number];
export type MemberBindingStatus =
  | "initializing"
  | "ready"
  | "blocked"
  | "disabled";
export type MemberCredential = {
  id: string;
  sessionId: string;
  agentId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
};

/** Names only: secret values remain in the Core process environment. */
export const toolEnvironmentKeys: Record<ProxyToolId, readonly string[]> = {
  codex: [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
  ],
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
  ],
  qwen: [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "QWEN_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GOOGLE_API_KEY",
    "GOOGLE_MODEL",
  ],
  zcode: [],
  mimo: [],
  opencode: [],
  gemini: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_GEMINI_BASE_URL",
  ],
  kimi: ["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"],
  cursor: ["CURSOR_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  copilot: [
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_WIRE_API",
    "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_MODEL",
  ],
};

const toolInstallationShape = z
  .object({
    toolId: z.enum(proxyToolIds),
    displayName: z.string().trim().min(1).max(120),
    executablePath: z.string().trim().min(1),
    executableArgs: z.array(z.string()).max(32).default([]),
    environmentKeys: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .max(20)
      .default([]),
    version: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

const validateToolInstallation = (
  value: {
    toolId: ProxyToolId;
    executableArgs: string[];
    environmentKeys: string[];
  },
  context: z.RefinementCtx,
) => {
  if (
    value.executableArgs.some((argument) =>
      /^(--(?:resume|continue|last|fork(?:-session)?|session(?:-id)?)|-r|-c|-S|-C|-s)(=|$)/.test(
        argument,
      ),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["executableArgs"],
      message:
        "Session selection is controlled by the member binding, not launcher arguments",
    });
  }
  if (
    value.executableArgs.some((argument) =>
      /^--(?:[a-z]+-)*(?:api-key|auth-token|password|token|secret)(=|$)/i.test(
        argument,
      ),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["executableArgs"],
      message:
        "Use native credential storage or environment key references instead of secret launcher arguments",
    });
  }
  if (
    value.environmentKeys.some(
      (key) => !toolEnvironmentKeys[value.toolId].includes(key),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["environmentKeys"],
      message:
        "Only documented model environment keys for this tool may be inherited",
    });
  }
};

export const createToolInstallationInputSchema =
  toolInstallationShape.superRefine(validateToolInstallation);
export type CreateToolInstallationInput = z.input<
  typeof createToolInstallationInputSchema
>;
export type ToolInstallation = z.output<
  typeof createToolInstallationInputSchema
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  compatibility?: import("./tool-compatibility.js").ToolCompatibility;
};

export const updateToolInstallationInputSchema = toolInstallationShape
  .omit({ toolId: true })
  .partial();
export type UpdateToolInstallationInput = z.input<
  typeof updateToolInstallationInputSchema
>;

export const nativeSessionBindingSchema = z
  .object({
    installationId: z.string().min(1),
    workspacePath: z.string().trim().min(1),
    runtimeNamespace: z.string().trim().default(""),
    nativeSessionId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(value),
        "Native session ID must be a literal ID, not a CLI option",
      ),
    endpoint: z.string().url().nullable().default(null),
    zcodeMode: z.enum(["build", "edit", "plan", "guarded", "yolo"]).optional(),
  })
  .strict();
export type NativeSessionBinding = z.output<typeof nativeSessionBindingSchema>;
/** Configuration needed before a vendor creates a native session. */
export const nativeSessionBindingDraftSchema =
  nativeSessionBindingSchema.extend({
    nativeSessionId: z.string().trim().max(512).optional(),
  });
export type NativeSessionBindingDraft = z.output<
  typeof nativeSessionBindingDraftSchema
>;
export type NativeSessionCandidate = {
  id: string;
  workspacePath: string;
  updatedAt: string | null;
};
export type NativeSessionDiscoveryResult = {
  sessions: NativeSessionCandidate[];
  truncated: boolean;
};

export const updateMemberRouteInputSchema = z.discriminatedUnion("accessMode", [
  z
    .object({
      accessMode: z.literal("managed_proxy"),
      expectedBindingVersion: z.number().int().positive(),
      /** Empty/omitted nativeSessionId explicitly requests a fresh session on first delivery. */
      binding: nativeSessionBindingDraftSchema,
      disabled: z.boolean().default(false),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      accessMode: z.enum(["mcp_await", "cli_await"]),
      disabled: z.boolean().default(false),
      expectedBindingVersion: z.number().int().positive(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type UpdateMemberRouteInput = z.input<
  typeof updateMemberRouteInputSchema
>;

export const createProxyMemberInputSchema = z
  .object({
    agentName: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120).optional(),
    role: z.enum(["worker", "knowledge_keeper"]).default("worker"),
    roleDescription: z.string().trim().min(1).max(4000),
    binding: nativeSessionBindingDraftSchema,
  })
  .strict();
export type CreateProxyMemberInput = z.input<
  typeof createProxyMemberInputSchema
>;

export type SessionMemberRoute = {
  sessionId: string;
  agentId: string;
  accessMode: MemberAccessMode;
  bindingStatus: MemberBindingStatus;
  bindingVersion: number;
  binding: NativeSessionBinding | null;
  nativeSessionKey: string | null;
  verifiedAt: string | null;
  verifiedToolVersion: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionMemberRouteView = {
  agent: Agent;
  route: SessionMemberRoute;
  installation: ToolInstallation | null;
};

export type MemberRouteEvent = {
  id: string;
  sessionId: string;
  agentId: string;
  bindingVersion: number;
  reason: string;
  before: SessionMemberRoute;
  after: SessionMemberRoute;
  createdAt: string;
};

export const namedSendInputSchema = z
  .object({
    sessionName: z.string().trim().min(1),
    from: z.string().trim().min(1),
    to: z.array(z.string().trim().min(1)).min(1).max(100),
    type: z.enum(["task", "task_report", "question", "answer", "announcement"]),
    content: z
      .unknown()
      .refine((value) => value !== undefined, "Message content is required"),
    idempotencyKey: z.string().trim().min(1).max(512),
    correlationId: z.string().min(1).optional(),
  })
  .strict();
export type NamedSendInput = z.input<typeof namedSendInputSchema>;
