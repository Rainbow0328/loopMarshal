import type { WebAgentRuntime } from "@loopmarshal/protocol";

export function RuntimeControls({
  runtime,
  onCommand,
  compact = false,
}: {
  runtime: WebAgentRuntime;
  onCommand: (command: "start" | "pause" | "stop") => void;
  compact?: boolean;
}) {
  const btnClass = compact ? "btn btn-sm" : "btn";
  return (
    <div style={{ display: "flex", gap: "var(--sp-1)" }}>
      {runtime.status !== "running" ? (
        <button
          className={`${btnClass} btn-secondary`}
          onClick={() => onCommand("start")}
        >
          启动
        </button>
      ) : (
        <button
          className={`${btnClass} btn-secondary`}
          onClick={() => onCommand("pause")}
        >
          暂停
        </button>
      )}
      <button
        className={`${btnClass} btn-ghost`}
        onClick={() => onCommand("stop")}
      >
        停止
      </button>
    </div>
  );
}
