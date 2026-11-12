import { pushToast } from "@/components/ui";

export async function openActivityWindow(sessionId: string, memberId?: string) {
  try {
    if (window.loopmarshalDesktop?.openActivityWindow)
      await window.loopmarshalDesktop.openActivityWindow(sessionId, memberId);
    else {
      const query = new URLSearchParams({
        sessionId,
        ...(memberId ? { memberId } : {}),
      });
      const opened = window.open(
        `/activity?${query}`,
        "_blank",
        "noopener,noreferrer,width=850,height=780",
      );
      // noopener intentionally gives no window handle; browsers handle blocked popups.
      void opened;
    }
  } catch {
    pushToast("观察窗口未能打开，可继续在实时动态中查看", "error");
  }
}
