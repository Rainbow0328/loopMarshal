import { DiscussionConversation } from "./DiscussionConversation";
import { PageHeader, PageContainer } from "@/components/PageHeader";
import { getApiClient, api } from "@/lib/api-client";
import { toolAvailability } from "@loopmarshal/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import "./discussions.css";

export function DiscussionsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cliIds, setCliIds] = useState<string[]>([]);
  const [roots, setRoots] = useState<Record<string, string>>({});
  const rooms = useQuery({
    queryKey: ["discussions"],
    queryFn: () => client.listDiscussions(),
    refetchInterval: (q) => (q.state.data?.some((r) => r.busy) ? 1500 : false),
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api.models.list(),
  });
  const tools = useQuery({
    queryKey: ["tool-installations"],
    queryFn: () => client.listToolInstallations(),
  });
  const profiles = useQuery({
    queryKey: ["tool-config-profiles"],
    queryFn: () => client.listToolConfigProfiles(),
  });
  const room = rooms.data?.find((item) => item.id === roomId);
  const create = useMutation({
    mutationFn: () =>
      client.createDiscussion({
        name,
        modelIds: selected,
        cliMembers: cliIds.map((id) => ({
          installationId: id,
          runtimeNamespace: roots[id],
        })),
      }),
    onSuccess: async (value) => {
      await qc.invalidateQueries({ queryKey: ["discussions"] });
      setRoomId(value.id);
      setName("");
      setSelected([]);
      setCliIds([]);
    },
  });
  const toggle = (id: string, list: string[], update: (v: string[]) => void) =>
    update(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  const count = selected.length + cliIds.length;
  return (
    <>
      <PageHeader
        title="讨论室"
        subtitle="围绕问题交流，将共识整理为可复用的知识"
      />
      <PageContainer>
        <div className="discussion-layout">
          <aside className="discussion-sidebar card">
            <button
              className="btn btn-secondary"
              onClick={() => setRoomId(null)}
            >
              ＋ 新建讨论室
            </button>
            {rooms.isLoading && <p>正在读取讨论室…</p>}
            {rooms.error && <p role="alert">{rooms.error.message}</p>}
            <div className="discussion-room-list">
              {rooms.data?.map((item) => (
                <button
                  key={item.id}
                  className={`discussion-room ${item.id === roomId ? "active" : ""}`}
                  onClick={() => setRoomId(item.id)}
                >
                  <strong>
                    {item.name}
                    {item.busy && " · 讨论中"}
                  </strong>
                  <span>{item.members.map((m) => m.name).join("、")}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="discussion-main card">
            {room ? (
              <DiscussionConversation key={room.id} room={room} />
            ) : (
              <div className="discussion-create">
                <h2>新建讨论室</h2>
                <p>
                  选择 1–8
                  个成员。每轮可指定回复者；下一轮可以让成员比较、补充上一轮观点。
                </p>
                <label>
                  讨论室名称（必填）
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    placeholder="例如：产品方案讨论"
                  />
                </label>
                <fieldset>
                  <legend>已有模型</legend>
                  {models.isLoading && <p>正在读取模型…</p>}
                  {models.data?.map((model) => (
                    <label className="discussion-choice" key={model.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(model.id)}
                        disabled={!selected.includes(model.id) && count >= 8}
                        onChange={() => toggle(model.id, selected, setSelected)}
                      />
                      {model.name}
                      <span>{model.modelId}</span>
                    </label>
                  ))}
                  {models.data?.length === 0 && (
                    <p>
                      还没有模型，前往 <Link to="/models">模型配置</Link> 添加。
                    </p>
                  )}
                </fieldset>
                <fieldset>
                  <legend>本机 Worker</legend>
                  <p>
                    Codex、Claude Code
                    使用独立原生会话，关闭执行工具，不读写项目文件。请先完成模型配置或官方登录。
                  </p>
                  {tools.isLoading && <p>正在读取 Worker…</p>}
                  {tools.data?.map((tool) => {
                    const availability = tool.compatibility
                      ? toolAvailability(tool.compatibility)
                      : undefined;
                    const supported =
                      ["codex", "claude"].includes(tool.toolId) &&
                      !tool.executableArgs.length &&
                      availability?.status !== "unavailable";
                    const root =
                      roots[tool.id] ??
                      profiles.data?.profiles.find(
                        (p) => p.installationId === tool.id,
                      )?.configRoot ??
                      profiles.data?.defaults[tool.toolId] ??
                      "";
                    return (
                      <div key={tool.id}>
                        <label className="discussion-choice">
                          <input
                            type="checkbox"
                            disabled={
                              !supported ||
                              (!cliIds.includes(tool.id) && count >= 8)
                            }
                            checked={cliIds.includes(tool.id)}
                            onChange={() => {
                              toggle(tool.id, cliIds, setCliIds);
                              setRoots((current) => ({
                                ...current,
                                [tool.id]: root,
                              }));
                            }}
                          />
                          {tool.displayName}
                          {!supported && (
                            <span>
                              {availability?.status === "unavailable"
                                ? [availability.reason, availability.action]
                                    .filter(Boolean)
                                    .join(" ")
                                : tool.executableArgs.length
                                  ? "请添加不含额外启动参数的工具入口"
                                  : "尚未适配关闭执行工具的讨论模式，可用于项目协作"}
                            </span>
                          )}
                        </label>
                        {cliIds.includes(tool.id) && (
                          <label className="discussion-cli-root">
                            读取此目录的模型与登录配置
                            <input
                              className="input"
                              value={root}
                              onChange={(e) =>
                                setRoots((current) => ({
                                  ...current,
                                  [tool.id]: e.target.value,
                                }))
                              }
                            />
                          </label>
                        )}
                      </div>
                    );
                  })}
                  {!tools.data?.length && !tools.isLoading && (
                    <p>
                      前往 <Link to="/tools">发现 Worker</Link> 添加或安装工具。
                    </p>
                  )}
                </fieldset>
                {(models.error ??
                  tools.error ??
                  profiles.error ??
                  create.error) && (
                  <p role="alert">
                    {
                      (
                        models.error ??
                        tools.error ??
                        profiles.error ??
                        create.error
                      )?.message
                    }
                  </p>
                )}
                <button
                  className="btn btn-primary"
                  disabled={
                    !name.trim() || !count || count > 8 || create.isPending
                  }
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? "正在创建…" : `创建讨论室（${count}/8）`}
                </button>
              </div>
            )}
          </section>
        </div>
      </PageContainer>
    </>
  );
}
