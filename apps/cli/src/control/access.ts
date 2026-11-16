import { ControlError } from "./errors.js";

export type MemberRole = "host" | "worker" | "knowledge_keeper";

function isMemberRole(role: unknown): role is MemberRole {
  return role === "host" || role === "worker" || role === "knowledge_keeper";
}

export function canControlApplication(
  role?: string,
  memberToken?: string,
): boolean {
  return !memberToken && (!role || role === "host");
}

export function assertControlAccess(): void {
  if (
    !canControlApplication(
      process.env.LOOPMARSHAL_ROLE,
      process.env.LOOPMARSHAL_MEMBER_TOKEN,
    )
  )
    throw new ControlError(
      "PERMISSION_DENIED",
      "应用管理入口需要本机管理身份。Worker 和仅持成员凭据的连接继续使用原有协作工具；请从用户侧 CLI 或管理连接调用应用操作。",
    );
}

/** One stdio connection has one committed role; attach is an atomic transition. */
export class McpAccessPolicy {
  private runtimeRole: MemberRole | undefined;
  private attaching = false;

  constructor(
    private readonly configuredRole = process.env.LOOPMARSHAL_ROLE,
    private readonly memberToken = process.env.LOOPMARSHAL_MEMBER_TOKEN,
  ) {}

  get role(): MemberRole | undefined {
    return isMemberRole(this.configuredRole)
      ? this.configuredRole
      : this.runtimeRole;
  }

  get canManageApplication(): boolean {
    return (
      !this.attaching &&
      canControlApplication(
        this.configuredRole || this.runtimeRole,
        this.memberToken,
      )
    );
  }

  get canUseHostTools(): boolean {
    if (this.attaching) return false;
    return (
      this.role === "host" ||
      (!this.configuredRole && !this.runtimeRole && !this.memberToken)
    );
  }

  assertApplicationAccess(): void {
    if (!this.canManageApplication)
      throw new ControlError(
        "PERMISSION_DENIED",
        "当前 MCP 连接不能使用应用管理入口，请使用本机管理连接。",
      );
  }

  async attach<T>(role: unknown, operation: () => Promise<T>): Promise<T> {
    if (!isMemberRole(role))
      throw new ControlError(
        "INVALID_INPUT",
        "请选择 host、worker 或 knowledge_keeper 角色。",
      );
    if (this.attaching)
      throw new ControlError(
        "CONFLICT",
        "此连接正在加入会话，请等待本次操作完成。",
      );
    const current = this.configuredRole || this.runtimeRole;
    if (current && role !== current)
      throw new ControlError(
        "PERMISSION_DENIED",
        "此 MCP 连接已绑定角色，请使用另一个连接切换角色。",
      );
    this.attaching = true;
    try {
      const result = await operation();
      this.runtimeRole = role;
      return result;
    } finally {
      this.attaching = false;
    }
  }
}
