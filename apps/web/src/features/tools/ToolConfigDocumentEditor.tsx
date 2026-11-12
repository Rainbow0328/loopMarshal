import { Icon } from "@/components/Icon";
import { Field, pushToast } from "@/components/ui";
import { getApiClient } from "@/lib/api-client";
import {
  type ToolConfigDocument,
  type ToolConfigPreview,
} from "@loopmarshal/protocol";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function DocumentEditor({
  profileId,
  document,
  onSaved,
  onDirtyChange,
}: {
  profileId: string;
  document: ToolConfigDocument;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const api = getApiClient();
  const [values, setValues] = useState<
    Record<string, string | boolean | number | null>
  >({});
  const [preview, setPreview] = useState<ToolConfigPreview | null>(null);
  const codexAuth = document.fields.some(
    (field) => field.id === "provider_api_key",
  );
  const initialAuth =
    document.fields.find(
      (field) => field.id === "provider_requires_openai_auth",
    )?.value === true
      ? "login"
      : document.fields.find((field) => field.id === "provider_env_key")
            ?.configured
        ? "environment"
        : document.fields.find((field) => field.id === "provider_api_key")
              ?.configured
          ? "api_key"
          : "login";
  const [authMode, setAuthMode] = useState(initialAuth);
  const dirty = Object.keys(values).length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const edit = (id: string, value: string | boolean | number | null) => {
    setPreview(null);
    setValues((old) => {
      const next = { ...old, [id]: value };
      const original = document.fields.find((field) => field.id === id);
      if (
        original &&
        !original.secret &&
        String(original.value ?? "") === String(value ?? "")
      )
        delete next[id];
      if (original?.secret && !original.configured && value === null)
        delete next[id];
      return next;
    });
  };
  const inspect = useMutation({
    mutationFn: () =>
      api.previewToolConfig(profileId, {
        documentId: document.id,
        expectedFingerprint: document.fingerprint,
        values,
      }),
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => api.applyToolConfig(profileId, preview!.previewId),
    onSuccess: () => {
      setPreview(null);
      setValues({});
      onDirtyChange(false);
      onSaved();
      pushToast("已保存到工具配置，备份已生成", "success");
    },
  });
  const codexAuthIds = [
    "provider_env_key",
    "provider_api_key",
    "provider_requires_openai_auth",
  ];
  const connectionIds = [
    "base_url",
    "provider_base_url",
    "api_key",
    "auth_token",
    "model",
    "model_id",
    "model_protocol",
    "model_provider",
    "auth_type",
    "provider",
  ];
  const isConnectionField = (field: ToolConfigDocument["fields"][number]) =>
    connectionIds.includes(field.id) ||
    /^custom_\d+_(model|base_url|api_key)$/.test(field.id);
  const hasConnection = document.fields.some(isConnectionField);
  const connectionFields = document.fields.filter(
    (field) => !hasConnection || isConnectionField(field),
  );
  const moreFields = hasConnection
    ? document.fields.filter(
        (field) =>
          !isConnectionField(field) && !codexAuthIds.includes(field.id),
      )
    : [];
  const authField = document.fields.find(
    (field) =>
      field.id ===
      (authMode === "environment" ? "provider_env_key" : "provider_api_key"),
  );
  const selectAuth = (mode: string) => {
    setAuthMode(mode);
    edit("provider_requires_openai_auth", mode === "login");
    edit(
      "provider_env_key",
      mode === "environment"
        ? String(
            document.fields.find((field) => field.id === "provider_env_key")
              ?.value ?? "OPENAI_API_KEY",
          )
        : null,
    );
    edit("provider_api_key", null);
    if (mode === "api_key" && initialAuth === "api_key")
      setValues((current) => {
        const next = { ...current };
        delete next.provider_api_key;
        return next;
      });
  };
  const missingAuth =
    codexAuth &&
    (authMode === "environment"
      ? !String(
          values.provider_env_key === undefined
            ? (authField?.value ?? "")
            : (values.provider_env_key ?? ""),
        ).trim()
      : authMode === "api_key" &&
        !(values.provider_api_key === undefined
          ? authField?.configured
          : values.provider_api_key));
  const renderField = (field: ToolConfigDocument["fields"][number]) => (
    <Field key={field.id} label={field.label} hint={field.description}>
      <div className="native-field-heading">
        <code>{field.id}</code>
        {field.secret && <span>{field.configured ? "已配置" : "未配置"}</span>}
      </div>
      <div className="native-field-control">
        {field.kind === "boolean" ? (
          <select
            className="input"
            aria-label={field.label}
            value={String(
              values[field.id] === undefined
                ? (field.value ?? "")
                : (values[field.id] ?? ""),
            )}
            onChange={(event) =>
              edit(
                field.id,
                event.target.value === ""
                  ? null
                  : event.target.value === "true",
              )
            }
          >
            <option value="">工具默认值</option>
            <option value="true">启用</option>
            <option value="false">关闭</option>
          </select>
        ) : field.options ? (
          <select
            className="input"
            aria-label={field.label}
            value={
              values[field.id] === undefined
                ? String(field.value ?? "")
                : String(values[field.id] ?? "")
            }
            onChange={(event) => edit(field.id, event.target.value || null)}
          >
            <option value="">工具默认值</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            aria-label={field.label}
            value={
              values[field.id] === undefined
                ? String(field.value ?? "")
                : String(values[field.id] ?? "")
            }
            placeholder={
              field.secret
                ? field.configured
                  ? "已配置，填写新值以替换"
                  : "填写密钥或令牌"
                : "使用工具默认值"
            }
            onChange={(event) => edit(field.id, event.target.value || null)}
          />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={`清除${field.label}`}
          onClick={() => edit(field.id, null)}
        >
          清除
        </button>
      </div>
      {values[field.id] === null && (
        <small className="config-field-removal">
          保存时移除此字段，交由工具使用其他配置或默认值。
        </small>
      )}
    </Field>
  );
  return (
    <div className="config-document native-config-document">
      <div className="native-config-location">
        <Icon name="file" size={15} />
        <code title={document.path}>{document.path}</code>
        <span>{document.exists ? "已读取" : "保存时创建"}</span>
      </div>
      {document.warning && (
        <p className="native-config-note">{document.warning}</p>
      )}
      {document.scope === "project" && (
        <p className="config-warning">
          此配置位于项目目录，可能进入版本库。密钥建议保存在用户配置。
        </p>
      )}
      {(inspect.error ?? save.error) && (
        <p role="alert" className="config-warning">
          {(inspect.error ?? save.error)?.message}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          inspect.mutate();
        }}
      >
        {connectionFields.length > 0 && (
          <div className="native-field-section">
            <h3>{hasConnection ? "模型与连接" : "工具设置"}</h3>
            <p>修改后保存，工具下次执行时读取。</p>
            <div className="native-field-grid">
              {connectionFields.map(renderField)}
            </div>
          </div>
        )}
        {codexAuth && (
          <div className="native-field-section codex-auth-section">
            <h3>认证</h3>
            <div className="native-field-grid">
              <Field label="认证方式">
                <select
                  className="input"
                  aria-label="认证方式"
                  value={authMode}
                  onChange={(event) => selectAuth(event.target.value)}
                >
                  <option value="login">沿用 Codex 登录</option>
                  <option value="environment">使用环境变量</option>
                  <option value="api_key">直接填写 API Key</option>
                </select>
              </Field>
              {authMode === "environment" && (
                <Field
                  label="密钥环境变量名"
                  required
                  hint="填写变量名称，例如 OPENAI_API_KEY；在安装设置中允许继承，并确保启动客户端前已设置该变量。"
                >
                  <input
                    className="input"
                    aria-label="密钥环境变量名"
                    required
                    pattern="[A-Za-z_][A-Za-z0-9_]*"
                    placeholder="OPENAI_API_KEY"
                    value={String(
                      values.provider_env_key === undefined
                        ? (authField?.value ?? "")
                        : (values.provider_env_key ?? ""),
                    )}
                    onChange={(event) =>
                      edit("provider_env_key", event.target.value || null)
                    }
                  />
                </Field>
              )}
              {authMode === "api_key" && (
                <Field
                  label="API Key"
                  required
                  hint={
                    authField?.configured
                      ? "已保存密钥，留空保留；填写新值替换。"
                      : "保存到 Codex 当前服务商配置，下次执行时读取。"
                  }
                >
                  <input
                    className="input"
                    aria-label="API Key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    required={
                      !authField?.configured || values.provider_api_key === null
                    }
                    placeholder={
                      authField?.configured
                        ? "已配置，填写新值以替换"
                        : "输入 API Key"
                    }
                    value={String(values.provider_api_key ?? "")}
                    onChange={(event) => {
                      if (!event.target.value && authField?.configured) {
                        setValues((current) => {
                          const next = { ...current };
                          delete next.provider_api_key;
                          return next;
                        });
                        setPreview(null);
                      } else
                        edit("provider_api_key", event.target.value || null);
                    }}
                  />
                </Field>
              )}
            </div>
            {authMode === "login" && (
              <p>使用 Codex 已有的登录状态，LoopMarshal 不读取登录凭据。</p>
            )}
          </div>
        )}
        {moreFields.length > 0 && (
          <details className="native-extra-fields" open={undefined}>
            <summary>
              模型映射与其他设置（
              {moreFields.filter((field) => field.configured).length} 项已配置）
            </summary>
            <div className="native-field-grid">
              {moreFields.map(renderField)}
            </div>
          </details>
        )}
        {preview ? (
          <div
            className="config-preview native-config-preview"
            role="region"
            aria-label="待保存的修改"
          >
            <strong>确认修改（{preview.changes.length} 项）</strong>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>设置</th>
                    <th>原值</th>
                    <th>新值</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change) => (
                    <tr key={change.fieldId}>
                      <td>
                        {
                          document.fields.find(
                            (field) => field.id === change.fieldId,
                          )?.label
                        }
                      </td>
                      <td>{String(change.before ?? "默认值")}</td>
                      <td>{String(change.after ?? "默认值")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="native-save-actions">
              <span>保存前自动备份，其他配置原样保留。</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPreview(null)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "保存中…" : "确认写入"}
              </button>
            </div>
          </div>
        ) : (
          document.fields.length > 0 && (
            <div className="native-save-bar">
              <span>
                {dirty
                  ? `${Object.keys(values).length} 项待保存`
                  : "修改会写入上方文件"}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!dirty}
                onClick={() => {
                  setValues({});
                  setPreview(null);
                  setAuthMode(initialAuth);
                  onDirtyChange(false);
                }}
              >
                撤销修改
              </button>
              <button
                className="btn btn-primary"
                disabled={inspect.isPending || !dirty || missingAuth}
              >
                {inspect.isPending ? "检查修改…" : "保存修改"}
              </button>
            </div>
          )
        )}
      </form>
      <details className="native-effective-note">
        <summary>配置何时生效？</summary>
        <p>{document.effectiveAfter}</p>
      </details>
    </div>
  );
}
