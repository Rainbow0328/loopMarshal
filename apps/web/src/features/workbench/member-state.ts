import type { BadgeVariant } from "@/components/ui";
import type { ConsoleMember, WebAgentRuntime } from "@loopmarshal/protocol";

export function memberState(
  member: ConsoleMember,
  runtime?: WebAgentRuntime | null,
): { label: string; variant: BadgeVariant } {
  if (member.activity?.unknown)
    return { label: "执行异常，需核对结果", variant: "warning" };
  if (member.route?.bindingStatus === "disabled")
    return { label: "已停用", variant: "neutral" };
  if (member.route?.bindingStatus === "blocked" || member.activity?.blocked)
    return { label: "连接异常", variant: "error" };
  if (
    member.route?.bindingStatus === "initializing" &&
    member.route.binding?.nativeSessionId.startsWith("loopmarshal-pending:")
  )
    return { label: "等待首次消息", variant: "info" };
  if (member.route?.bindingStatus === "initializing")
    return { label: "等待连接检查", variant: "warning" };
  if (runtime)
    return {
      label:
        (
          {
            running: "运行中",
            idle: "空闲",
            paused: "已暂停",
            stopped: "已停止",
            error: "运行异常",
          } as Record<string, string>
        )[runtime.status] ?? runtime.status,
      variant:
        runtime.status === "error"
          ? "error"
          : runtime.status === "running"
            ? "success"
            : "neutral",
    };
  if (member.activity?.running || member.status === "working")
    return { label: "执行中", variant: "accent" };
  if (member.activity?.lastFailure)
    return { label: "上次执行失败", variant: "error" };
  if (member.route?.accessMode === "managed_proxy")
    return {
      label: member.activity?.queued
        ? `排队 ${member.activity.queued} 项`
        : "待命",
      variant: "info",
    };
  return member.status === "offline"
    ? { label: "等待外部工具接入", variant: "neutral" }
    : { label: "已接入", variant: "info" };
}
