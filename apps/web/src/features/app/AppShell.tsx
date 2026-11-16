import {
  DesktopTitlebar,
  hasDesktopTitlebar,
} from "@/components/DesktopTitlebar";
import { Icon, LoopMark, type IconName } from "@/components/Icon";
import { useTheme } from "@/components/shared/ThemeProvider";
import { ToastContainer } from "@/components/ui";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
const NAV_GROUPS = [
  {
    label: "协作",
    items: [
      { to: "/", label: "当前协作", icon: "workspace" },
      { to: "/discussions", label: "讨论室", icon: "model" },
      { to: "/knowledge", label: "知识库", icon: "book" },
    ],
  },
  {
    label: "资源",
    items: [
      { to: "/models", label: "模型配置", icon: "model" },
      { to: "/tools", label: "发现 Worker", icon: "terminal" },
      { to: "/tool-config", label: "工具配置", icon: "settings" },
      { to: "/mcp", label: "扩展能力", icon: "plug" },
    ],
  },
  {
    label: "偏好",
    items: [{ to: "/preferences", label: "工作习惯", icon: "settings" }],
  },
] as const;
export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 600px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const resize = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const navigation = document.querySelector<HTMLElement>(".app-sidebar");
    navigation?.querySelector<HTMLElement>("a")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        return;
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          navigation?.querySelectorAll<HTMLElement>("a, button") ?? [],
        ).filter((element) => element.getClientRects().length > 0);
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
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [mobileOpen]);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("loopmarshal-nav-collapsed") === "true",
  );
  if (pathname === "/activity")
    return (
      <>
        <DesktopTitlebar observer />
        <main
          className={`observer-shell ${hasDesktopTitlebar ? "has-desktop-titlebar" : ""}`}
        >
          <Outlet />
          <ToastContainer />
        </main>
      </>
    );
  return (
    <>
      <DesktopTitlebar collapsed={collapsed} />
      <div
        className={`app-shell ${hasDesktopTitlebar ? "has-desktop-titlebar" : ""} ${collapsed ? "nav-collapsed" : ""} ${mobileOpen ? "mobile-nav-open" : ""}`}
      >
        <a className="skip-link" href="#main-content">
          跳至主要内容
        </a>
        {mobileOpen && (
          <button
            className="nav-scrim"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className="app-sidebar"
          aria-label="主导航"
          inert={isMobile && !mobileOpen}
        >
          <button
            className="mobile-nav-close btn btn-ghost btn-icon"
            aria-label="关闭导航菜单"
            onClick={() => setMobileOpen(false)}
          >
            <Icon name="close" size={18} />
          </button>
          <Link
            to="/"
            className="brand"
            onClick={() => setMobileOpen(false)}
            aria-label="LoopMarshal 首页"
          >
            <span className="brand-symbol">
              <LoopMark size={34} />
            </span>
            <span className="brand-copy">
              <strong>LoopMarshal</strong>
              <span>让 AI 协作有序进行</span>
            </span>
          </Link>
          <p className="sidebar-context">
            本地协作空间
            <span>项目和会话始终保持在当前上下文</span>
          </p>
          <nav className="sidebar-nav">
            {NAV_GROUPS.map((group) => (
              <div className="nav-group" key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                {group.items.map((item) => {
                  const active =
                    item.to === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`nav-item ${active ? "is-active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      title={item.label}
                      onClick={() => setMobileOpen(false)}
                    >
                      <Icon name={item.icon as IconName} size={19} />
                      <span>{item.label}</span>
                      {active && <span className="nav-active-dot" />}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <Icon name="shield" size={17} />
            </span>
            <div>
              <strong>本地优先</strong>
              <p>会话、知识和工具由本机统一管理</p>
            </div>
          </div>
          <div className="sidebar-footer">
            <button
              className="nav-item theme-toggle"
              onClick={toggleTheme}
              title={theme === "dark" ? "浅色模式" : "深色模式"}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
              <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
            </button>
            <button
              className="nav-collapse"
              aria-label={collapsed ? "展开导航" : "收起导航"}
              onClick={() => {
                localStorage.setItem(
                  "loopmarshal-nav-collapsed",
                  String(!collapsed),
                );
                setCollapsed(!collapsed);
              }}
            >
              <Icon name="panel" size={17} />
            </button>
          </div>
        </aside>
        <main
          className="app-main"
          id="main-content"
          tabIndex={-1}
          inert={mobileOpen}
        >
          <div className="mobile-bar">
            <button
              className="btn btn-ghost btn-icon"
              aria-label="打开导航"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>LoopMarshal</span>
          </div>
          <Outlet />
        </main>
        <ToastContainer />
      </div>
    </>
  );
}
