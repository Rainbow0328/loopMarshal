import { useEffect } from "react";
import { LoopMark } from "./Icon";
import { useTheme } from "./shared/ThemeProvider";

export const hasDesktopTitlebar = Boolean(
  window.loopmarshalDesktop?.customTitleBar,
);

export function DesktopTitlebar({
  collapsed = false,
  observer = false,
}: {
  collapsed?: boolean;
  observer?: boolean;
}) {
  const { theme } = useTheme();
  useEffect(() => {
    if (hasDesktopTitlebar)
      void window.loopmarshalDesktop?.setWindowTheme(theme).catch(() => {});
  }, [theme]);
  if (!hasDesktopTitlebar) return null;
  return (
    <div
      className={`desktop-titlebar ${collapsed ? "is-collapsed" : ""} ${observer ? "is-observer" : ""}`}
      aria-label="窗口拖动区域"
    >
      <div className="desktop-titlebar-brand">
        <LoopMark size={24} />
        <span>LoopMarshal</span>
      </div>
      {observer && <span className="desktop-titlebar-context">运行观察</span>}
    </div>
  );
}
