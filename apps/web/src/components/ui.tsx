import type { ReactNode } from "react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/* ==================== Badge ==================== */

export type BadgeVariant =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "accent"
  | "neutral";

export function Badge({
  variant = "neutral",
  dot = false,
  children,
}: {
  variant?: BadgeVariant;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${variant}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

/* ==================== Status Badge ==================== */

const STATUS_MAP: Record<string, BadgeVariant> = {
  active: "success",
  online: "success",
  completed: "success",
  processed: "success",
  running: "success",
  working: "accent",
  claimed: "accent",
  in_progress: "accent",
  waiting: "warning",
  pending: "warning",
  idle: "warning",
  paused: "warning",
  stopped: "warning",
  error: "error",
  failed: "error",
  offline: "error",
};

const STATUS_LABEL: Record<string, string> = {
  active: "在线",
  online: "在线",
  completed: "已完成",
  processed: "已处理",
  running: "运行中",
  working: "工作中",
  claimed: "处理中",
  in_progress: "执行中",
  waiting: "等待中",
  pending: "待处理",
  idle: "空闲",
  paused: "已暂停",
  stopped: "已停止",
  error: "异常",
  failed: "失败",
  offline: "离线",
};

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const variant = STATUS_MAP[status] ?? "neutral";
  return (
    <Badge variant={variant} dot>
      {label && label !== status ? label : (STATUS_LABEL[status] ?? status)}
    </Badge>
  );
}

/* ==================== Role Badge ==================== */

const ROLE_VARIANT: Record<string, BadgeVariant> = {
  host: "accent",
  worker: "info",
  knowledge_keeper: "success",
  observer: "neutral",
};

const ROLE_LABEL: Record<string, string> = {
  host: "Host",
  worker: "Worker",
  knowledge_keeper: "Keeper",
  observer: "Observer",
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant={ROLE_VARIANT[role] ?? "neutral"} dot>
      {ROLE_LABEL[role] ?? role}
    </Badge>
  );
}

/* ==================== Dialog / Modal ==================== */

const dialogStack: HTMLElement[] = [];
function updateDialogLayers() {
  dialogStack.forEach((element, index) => {
    const backdrop = element.parentElement;
    if (backdrop) {
      backdrop.inert = index !== dialogStack.length - 1;
      backdrop.style.zIndex = String(1000 + index);
    }
  });
  document
    .querySelector<HTMLElement>(".app-shell")
    ?.toggleAttribute("inert", dialogStack.length > 0);
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = panel.current;
    if (!element) return;
    dialogStack.push(element);
    updateDialogLayers();
    const timer = window.setTimeout(() => panel.current?.focus(), 0);
    const handler = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== panel.current) return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === panel.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handler, true);
      const index = dialogStack.indexOf(element);
      if (index >= 0) dialogStack.splice(index, 1);
      updateDialogLayers();
      if (previous?.isConnected && !previous.closest("[inert]"))
        previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={panel}
        style={{ maxWidth: width }}
      >
        <div className="dialog-header">
          <h2 id={id}>{title}</h2>
          <button
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ==================== Field ==================== */

export function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  let linked = false;
  const connect = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (!isValidElement<Record<string, unknown>>(node) || linked) return node;
      if (["input", "select", "textarea"].includes(String(node.type))) {
        linked = true;
        return cloneElement(node, {
          id: node.props.id ?? id,
          ...(!node.props["aria-label"] ? { "aria-label": label } : {}),
          ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
        });
      }
      return typeof node.type === "string" && node.props.children
        ? cloneElement(node, {
            children: connect(node.props.children as ReactNode),
          })
        : node;
    });
  return (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id} className="field-label">
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {connect(children)}
      {hint && (
        <div id={`${id}-hint`} className="field-hint">
          {hint}
        </div>
      )}
    </div>
  );
}

/* ==================== Confirm Dialog ==================== */

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={400}>
      <p
        style={{
          fontSize: "var(--fs-sm)",
          color: "var(--c-text-secondary)",
          lineHeight: 1.6,
        }}
      >
        {message}
      </p>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--sp-2)",
          marginTop: "var(--sp-5)",
        }}
      >
        <button className="btn btn-secondary" onClick={onClose}>
          {cancelText}
        </button>
        <button
          className={danger ? "btn btn-danger" : "btn btn-primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmText}
        </button>
      </div>
    </Dialog>
  );
}

/* ==================== Empty State ==================== */

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon ?? <Icon name="folder" />}</div>
      <div className="empty-state-title">{title}</div>
      {desc && <div className="empty-state-desc">{desc}</div>}
      {action && <div style={{ marginTop: "var(--sp-4)" }}>{action}</div>}
    </div>
  );
}

/* ==================== Loading ==================== */

export function Loading({ text = "加载中…" }: { text?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-8)",
        color: "var(--c-text-tertiary)",
        fontSize: "var(--fs-sm)",
      }}
    >
      <div className="spinner" />
      {text}
    </div>
  );
}

export function PageLoading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 200,
      }}
    >
      <div className="spinner spinner-lg" />
    </div>
  );
}

/* ==================== Toast ==================== */

type Toast = {
  id: number;
  message: string;
  type: "success" | "error" | "info" | "warning";
};
let toastCounter = 0;
const toastListeners: ((toasts: Toast[]) => void)[] = [];
let toasts: Toast[] = [];

function notifyToasts() {
  toastListeners.forEach((l) => l([...toasts]));
}

export function pushToast(message: string, type: Toast["type"] = "info") {
  const id = ++toastCounter;
  toasts = [...toasts, { id, message, type }];
  notifyToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notifyToasts();
  }, 3000);
}

export function ToastContainer() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    toastListeners.push(setList);
    return () => {
      toastListeners.splice(toastListeners.indexOf(setList), 1);
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        bottom: "var(--sp-5)",
        right: "var(--sp-5)",
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        pointerEvents: "none",
      }}
    >
      {list.map((t) => (
        <div
          key={t.id}
          className="card animate-slide-up"
          style={{
            padding: "var(--sp-3) var(--sp-4)",
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            fontSize: "var(--fs-sm)",
            fontWeight: 500,
            boxShadow: "var(--shadow-lg)",
            borderLeft: `3px solid var(--c-${t.type === "success" ? "success" : t.type === "error" ? "error" : t.type === "warning" ? "warning" : "info"})`,
            pointerEvents: "auto",
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="error-state">
      <Icon name="info" size={18} />
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
