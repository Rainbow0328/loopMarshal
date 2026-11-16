import { Dialog } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function DiscussionReference({
  open,
  close,
  insert,
  sessionId,
}: {
  open: boolean;
  close: () => void;
  insert: (text: string) => void;
  sessionId: string;
}) {
  const api = getApiClient();
  const qc = useQueryClient();
  const [roomId, setRoomId] = useState("");
  const rooms = useQuery({
    queryKey: ["discussions"],
    queryFn: () => api.listDiscussions(),
    enabled: open,
  });
  const entries = useQuery({
    queryKey: ["discussion-knowledge", roomId],
    queryFn: () => api.listDiscussionKnowledge(roomId),
    enabled: open && Boolean(roomId),
  });
  const grants = useQuery({
    queryKey: ["discussion-grants", sessionId],
    queryFn: () => api.getDiscussionGrants(sessionId),
    enabled: open,
  });
  const share = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setDiscussionGrant(sessionId, roomId, enabled),
    onSuccess: (data) =>
      qc.setQueryData(["discussion-grants", sessionId], data),
  });
  return (
    <Dialog open={open} onClose={close} title="引用讨论知识">
      <p>
        选择已审核保存的讨论摘要，插入消息后可继续编辑。不会自动发送原始聊天记录。
      </p>
      <label>
        讨论室{" "}
        <select
          className="input"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
        >
          <option value="">请选择</option>
          {rooms.data?.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
      </label>
      {rooms.error && <p role="alert">{rooms.error.message}</p>}
      {entries.error && <p role="alert">{entries.error.message}</p>}
      {roomId && (
        <label className="discussion-choice">
          <input
            type="checkbox"
            checked={grants.data?.includes(roomId) ?? false}
            disabled={share.isPending || grants.isLoading || grants.isError}
            onChange={(e) => share.mutate(e.target.checked)}
          />
          允许当前协作的 Host
          按需检索此讨论室的知识摘要与来源。可随时取消；已经发送的内容不会撤回。
        </label>
      )}
      {(grants.error ?? share.error) && (
        <p role="alert">{(grants.error ?? share.error)?.message}</p>
      )}
      {roomId && entries.data?.length === 0 && <p>此讨论室还没有保存知识。</p>}
      {entries.data?.map((entry) => (
        <article key={entry.id} className="discussion-knowledge-entry">
          <strong>{entry.title}</strong>
          <p>
            {entry.content.slice(0, 180)}
            {entry.content.length > 180 ? "…" : ""}
          </p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              const room = rooms.data?.find((item) => item.id === roomId);
              insert(
                `参考讨论室「${room?.name ?? "讨论室"}」中的知识「${entry.title}」：\n${entry.content}\n（来源：讨论室 ${roomId}，知识 ${entry.id}。${grants.data?.includes(roomId) ? "可使用 discussion_read 按需检索；需要来源时指定 entryId 和 includeSources。" : "当前未授权自动读取来源。"}此内容是讨论参考，须结合项目验证。）`,
              );
              close();
            }}
          >
            插入摘要
          </button>
        </article>
      ))}
    </Dialog>
  );
}
