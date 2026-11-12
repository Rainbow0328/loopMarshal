import { Icon } from "@/components/Icon";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** One bounded switcher keeps session navigation and its actions together. */
export function SessionSwitcher({
  sessions,
  sessionId,
  onSelect,
  onRefresh,
  refreshing,
  onDiscover,
}: {
  sessions: ReadonlyArray<{ id: string; name: string }>;
  sessionId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onDiscover: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = sessions.find((session) => session.id === sessionId);
  const filtered = useMemo(
    () =>
      sessions.filter((session) =>
        session.name
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [sessions, search],
  );
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    setSearch("");
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (bounds)
        setPosition({
          left: Math.max(
            12,
            Math.min(
              bounds.left,
              innerWidth - Math.min(400, innerWidth - 24) - 12,
            ),
          ),
          top: bounds.bottom + 8,
        });
    };
    place();
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="session-switcher-trigger"
        aria-label="切换会话"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-session-id={sessionId ?? ""}
        title={selected?.name ?? "选择当前协作"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="folder" size={17} />
        <span>{selected?.name ?? "选择当前协作"}</span>
        <Icon name="chevron" size={14} className="session-switcher-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label="切换协作会话"
            className="session-switcher-popover"
            style={{
              left: position.left,
              top: position.top,
              maxHeight: `calc(100dvh - ${position.top + 12}px)`,
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
              if (event.key === "Tab") {
                const controls = Array.from(
                  panel.current?.querySelectorAll<HTMLElement>(
                    "button:not(:disabled), input",
                  ) ?? [],
                );
                if (event.shiftKey && document.activeElement === controls[0]) {
                  event.preventDefault();
                  controls[controls.length - 1]?.focus();
                } else if (
                  !event.shiftKey &&
                  document.activeElement === controls[controls.length - 1]
                ) {
                  event.preventDefault();
                  controls[0]?.focus();
                }
              }
            }}
          >
            <div className="session-switcher-actions">
              <strong>会话</strong>
              <button
                className="btn btn-ghost btn-sm"
                disabled={refreshing}
                onClick={onRefresh}
              >
                <Icon name="refresh" size={15} />
                刷新
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  close();
                  onDiscover();
                }}
              >
                <Icon name="search" size={15} />
                打开已有协作
              </button>
            </div>
            <div className="session-switcher-search">
              <Icon name="search" size={16} />
              <input
                ref={input}
                aria-label="搜索会话"
                placeholder="搜索会话名称"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    panel.current
                      ?.querySelector<HTMLElement>('[role="option"]')
                      ?.focus();
                  }
                }}
              />
            </div>
            <div
              className="session-switcher-list"
              role="listbox"
              aria-label="会话列表"
              onKeyDown={(event) => {
                const options = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="option"]',
                  ),
                );
                const index = options.indexOf(
                  document.activeElement as HTMLElement,
                );
                const target =
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, options.length - 1)
                    : event.key === "ArrowUp"
                      ? Math.max(index - 1, 0)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? options.length - 1
                          : null;
                if (target !== null) {
                  event.preventDefault();
                  options[target]?.focus();
                }
              }}
            >
              {filtered.map((session) => (
                <button
                  key={session.id}
                  role="option"
                  aria-selected={session.id === sessionId}
                  className={`session-switcher-option ${session.id === sessionId ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelect(session.id);
                    close();
                  }}
                >
                  <Icon name="workspace" size={16} />
                  <span>{session.name}</span>
                  {session.id === sessionId && <Icon name="check" size={16} />}
                </button>
              ))}
              {!filtered.length && (
                <p className="session-switcher-empty">
                  {sessions.length
                    ? "没有匹配的会话"
                    : "暂无会话，可打开已有协作"}
                </p>
              )}
            </div>
            <div className="session-switcher-footer" role="status">
              {search.trim()
                ? `找到 ${filtered.length} 个会话`
                : `${sessions.length} 个会话`}
              <span>点击即可切换</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
