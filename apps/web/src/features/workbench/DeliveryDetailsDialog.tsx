import { Field } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import { type ProxyDelivery } from "@loopmarshal/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

export function DeliveryDetails({
  delivery,
  onChanged,
}: {
  delivery: ProxyDelivery;
  onChanged: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [summary, setSummary] = useState("");
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const [outcome, setOutcome] = useState<"reported" | "failed">("failed");
  const events = useQuery({
    queryKey: ["delivery-events", delivery.id],
    queryFn: () => getApiClient().getDeliveryEvents(delivery.id),
    enabled: opened,
    refetchInterval: opened ? 3000 : false,
  });
  const source = useQuery({
    queryKey: ["proxy-source", delivery.messageId],
    queryFn: () => getApiClient().getMessageById(delivery.messageId),
    enabled: opened,
  });
  const report = useQuery({
    queryKey: ["proxy-report", delivery.resultMessageId],
    queryFn: () => getApiClient().getMessageById(delivery.resultMessageId!),
    enabled: opened && Boolean(delivery.resultMessageId),
  });
  const reconcile = useMutation({
    mutationFn: () => {
      if (!confirmedStopped) throw new Error("请先确认原工具执行已停止。");
      return getApiClient().reconcileDelivery(delivery.id, {
        outcome,
        summary,
        confirmedStopped: true,
      });
    },
    onSuccess: onChanged,
  });
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>查看事件与处理</summary>
      {(events.error ?? reconcile.error) && (
        <p role="alert">{(events.error ?? reconcile.error)?.message}</p>
      )}
      <p>
        接收时间：{delivery.createdAt}
        <br />
        更新时间：{delivery.updatedAt}
        <br />
        绑定版本：{delivery.bindingVersion}
      </p>
      {source.data && (
        <details>
          <summary>原任务与关联信息</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(
              {
                payload: source.data.payload,
                correlationId: source.data.correlationId,
                from: source.data.fromAgentId,
                messageId: source.data.id,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {report.data && (
        <details>
          <summary>工具回报</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(report.data.payload, null, 2)}
          </pre>
        </details>
      )}
      {events.data?.map((event) => (
        <details key={event.sequence}>
          <summary>
            <small>
              {event.createdAt} · {event.type}
            </small>
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
      ))}
      {delivery.state === "unknown" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            reconcile.mutate();
          }}
          style={{
            display: "grid",
            gap: "var(--sp-2)",
            marginTop: "var(--sp-2)",
          }}
        >
          <Field label="核对结果">
            <select
              className="input"
              value={outcome}
              onChange={(event) =>
                setOutcome(event.target.value as typeof outcome)
              }
            >
              <option value="failed">任务未完成，记录失败</option>
              <option value="reported">已找到结果，交给 Host 验收</option>
            </select>
          </Field>
          <Field label="原生会话历史及文件检查结论">
            <textarea
              className="input"
              required
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              required
              checked={confirmedStopped}
              onChange={(event) => setConfirmedStopped(event.target.checked)}
            />{" "}
            已确认原工具执行停止
          </label>
          <button
            className="btn btn-secondary"
            disabled={reconcile.isPending || !confirmedStopped}
          >
            记录核对结果
          </button>
        </form>
      )}
    </details>
  );
}
