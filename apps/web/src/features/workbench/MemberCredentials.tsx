import { getApiClient } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function MemberCredentials({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}) {
  const [opened, setOpened] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const qc = useQueryClient();
  const queryKey = ["member-credentials", sessionId, agentId];
  const credentials = useQuery({
    queryKey,
    queryFn: () => getApiClient().listMemberCredentials(sessionId, agentId),
    enabled: opened,
  });
  const issue = useMutation({
    mutationFn: () =>
      getApiClient().issueMemberCredential(sessionId, agentId, label),
    onSuccess: (result) => {
      setToken(result.token);
      setLabel("");
      void qc.invalidateQueries({ queryKey });
      issue.reset();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      getApiClient().revokeMemberCredential(sessionId, agentId, id),
    onSuccess: () => {
      setToken(null);
      void qc.invalidateQueries({ queryKey });
    },
  });
  return (
    <details
      onToggle={(event) => {
        setOpened(event.currentTarget.open);
        if (!event.currentTarget.open) setToken(null);
      }}
    >
      <summary>发送凭证</summary>
      <p>凭证仅允许以这个成员的身份发送消息，不能管理绑定。</p>
      {(credentials.error ?? issue.error ?? revoke.error) && (
        <p role="alert">
          {(credentials.error ?? issue.error ?? revoke.error)?.message}
        </p>
      )}
      {credentials.data?.map((item) => (
        <div key={item.id}>
          {item.label} · {item.revokedAt ? "已撤销" : "有效"}
          {!item.revokedAt && (
            <button
              className="btn btn-secondary"
              onClick={() => revoke.mutate(item.id)}
              disabled={revoke.isPending}
            >
              撤销
            </button>
          )}
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          issue.mutate();
        }}
      >
        <input
          className="input"
          aria-label="凭证用途"
          placeholder="凭证用途"
          required
          maxLength={120}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button className="btn btn-secondary" disabled={issue.isPending}>
          签发
        </button>
      </form>
      {token && (
        <p>
          请保存此凭证，关闭后不再显示：
          <code style={{ overflowWrap: "anywhere" }}>{token}</code>
        </p>
      )}
    </details>
  );
}
