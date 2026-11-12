import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import {
  toolAvailability,
  toolCompatibility,
  type ProxyToolId,
  type ToolCompatibility,
} from "@loopmarshal/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function ToolCompatibilityNotice({
  toolId,
  compatibility,
  compact = false,
  endpoint,
  installationId,
  scope = "installation",
}: {
  toolId: ProxyToolId;
  compatibility?: ToolCompatibility;
  compact?: boolean;
  endpoint?: string | null;
  installationId?: string | undefined;
  scope?: "installation" | "session";
}) {
  const [checkedEndpoint, setCheckedEndpoint] = useState(
    endpoint?.trim() ?? "",
  );
  useEffect(() => {
    const timer = setTimeout(
      () => setCheckedEndpoint(endpoint?.trim() ?? ""),
      400,
    );
    return () => clearTimeout(timer);
  }, [endpoint]);
  const check = useQuery({
    queryKey: ["tool-readiness", installationId, checkedEndpoint],
    queryFn: () =>
      getApiClient().checkToolInstallation(
        installationId!,
        checkedEndpoint ? { endpoint: checkedEndpoint } : {},
      ),
    enabled: Boolean(installationId),
    staleTime: 30000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const fallback = toolAvailability(
    compatibility ?? toolCompatibility(toolId),
    endpoint,
    scope,
  );
  const missingService =
    scope === "session" &&
    ["mimo", "opencode"].includes(toolId) &&
    !endpoint?.trim();
  const value = check.error
    ? { status: "unavailable", reason: "校验未完成，请重新校验。" }
    : check.data?.availability.status === "unavailable"
      ? check.data.availability
      : missingService
        ? fallback
        : (check.data?.availability ?? fallback);
  const pending =
    (Boolean(installationId) && check.isFetching) ||
    checkedEndpoint !== (endpoint?.trim() ?? "");
  const available = value.status === "available";
  return (
    <div
      className={`tool-availability ${compact ? "tool-availability-compact" : ""} is-${value.status}`}
      role="note"
      aria-label="工具可用情况"
    >
      <Badge
        variant={
          pending
            ? "neutral"
            : available
              ? "success"
              : value.status === "unavailable"
                ? "error"
                : "warning"
        }
      >
        {pending ? "校验中…" : available ? "可用" : "不可用"}
      </Badge>
      {!pending && !available && (
        <div className="tool-availability-reason">
          <span>{value.reason}</span>
          {"action" in value && value.action && <span>{value.action}</span>}
        </div>
      )}
      {installationId && (
        <button
          type="button"
          className="tool-recheck"
          aria-label={`重新校验 ${toolId}`}
          title="重新校验"
          disabled={pending}
          onClick={() => void check.refetch()}
        >
          <Icon name="refresh" size={13} />
        </button>
      )}
    </div>
  );
}
