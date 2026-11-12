import type { ReactNode } from "react";
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {subtitle && (
          <p className="page-subtitle" title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="page-container">
      <div className="page-content">{children}</div>
    </div>
  );
}
