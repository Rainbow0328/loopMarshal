import { getApiClient } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";
import type { DiscussionRoom, DiscussionMessage } from "@loopmarshal/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export function DiscussionKnowledge({
  room,
  messages,
  close,
}: {
  room: DiscussionRoom;
  messages: DiscussionMessage[];
  close: () => void;
}) {
  const api = getApiClient();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [model, setModel] = useState(
    room.members.find((m) => !m.blocked)?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const entries = useQuery({
    queryKey: ["discussion-knowledge", room.id],
    queryFn: () => api.listDiscussionKnowledge(room.id),
  });
  const generate = useMutation({
    mutationFn: () =>
      api.draftDiscussionKnowledge(room.id, {
        modelId: model,
        sourceIds: chosen,
      }),
    onSuccess: (result) => {
      setDraft(result.content);
      setSources(result.sourceIds);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.saveDiscussionKnowledge(room.id, {
        title,
        content: draft,
        sourceIds: sources,
      }),
    onSuccess: () => {
      setDraft("");
      setTitle("");
      setSources([]);
      void qc.invalidateQueries({
        queryKey: ["discussion-knowledge", room.id],
      });
    },
  });
  return (
    <div className="discussion-knowledge">
      <div className="discussion-knowledge-head">
        <h3>讨论知识</h3>
        <button className="btn btn-ghost" onClick={close}>
          返回讨论
        </button>
      </div>
      <p>选择来源消息，让成员整理草稿；检查并修改后再保存。</p>
      <label>
        整理成员{" "}
        <select
          className="input"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {room.members.map((m) => (
            <option key={m.id} value={m.id} disabled={m.blocked}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="discussion-source-list">
        {messages
          .filter((m) => m.status === "complete")
          .map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={chosen.includes(m.id)}
                onChange={() =>
                  setChosen((current) =>
                    current.includes(m.id)
                      ? current.filter((id) => id !== m.id)
                      : [...current, m.id],
                  )
                }
              />
              <span>
                <strong>{m.speaker}</strong>：{m.content.slice(0, 120)}
                {m.content.length > 120 ? "…" : ""}
              </span>
            </label>
          ))}
      </div>
      <button
        className="btn btn-secondary"
        disabled={!chosen.length || !model || generate.isPending}
        onClick={() => generate.mutate()}
      >
        {generate.isPending ? "正在整理…" : "生成知识草稿"}
      </button>
      {generate.error && <p role="alert">{generate.error.message}</p>}
      {draft && (
        <div className="discussion-draft">
          <label>
            标题{" "}
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </label>
          <label>
            审核并编辑草稿{" "}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={40000}
              rows={12}
            />
          </label>
          <p>保存的来源为生成草稿时选择的 {sources.length} 条消息。</p>
          <button
            className="btn btn-primary"
            disabled={!title.trim() || !draft.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            保存到讨论知识
          </button>
          {save.error && <p role="alert">{save.error.message}</p>}
        </div>
      )}
      <h3>已保存的知识</h3>
      {entries.error && <p role="alert">{entries.error.message}</p>}
      {entries.data?.length === 0 && <p>还没有保存的知识。</p>}
      {entries.data?.map((entry) => (
        <article className="discussion-knowledge-entry" key={entry.id}>
          <h4>{entry.title}</h4>
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }}
          />
          <details>
            <summary>查看来源消息（{entry.sourceIds.length}）</summary>
            <KnowledgeSources roomId={room.id} entryId={entry.id} />
          </details>
        </article>
      ))}
    </div>
  );
}

function KnowledgeSources({
  roomId,
  entryId,
}: {
  roomId: string;
  entryId: string;
}) {
  const [open, setOpen] = useState(false);
  const sources = useQuery({
    queryKey: ["discussion-sources", roomId, entryId],
    queryFn: () =>
      getApiClient().getDiscussionKnowledgeSources(roomId, entryId),
    enabled: open,
  });
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        读取来源
      </button>
    );
  return (
    <>
      {sources.isLoading && <p>正在读取…</p>}
      {sources.error && <p role="alert">{sources.error.message}</p>}
      {sources.data?.map((source) => (
        <div key={source.id}>
          <strong>{source.speaker}</strong>
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(source.content) }}
          />
          {source.truncated && (
            <p>较长内容已缩略，可返回讨论记录查看完整消息。</p>
          )}
        </div>
      ))}
    </>
  );
}
