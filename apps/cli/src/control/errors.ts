import { z } from "zod";

export class ControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

/** Zod's enum/literal messages can echo input, including misplaced secrets. */
export function parseControlInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const field =
      issue.path
        .map((part) =>
          typeof part === "number" || /^[\w-]{1,64}$/.test(part)
            ? part
            : "<field>",
        )
        .join(".") || "input";
    const message =
      issue.code === "invalid_enum_value" || issue.code === "invalid_literal"
        ? "请选择该字段支持的值。"
        : issue.code === "unrecognized_keys"
          ? "包含不支持的字段，请查询操作参数。"
          : issue.message;
    return `${field}: ${message}`;
  });
  throw new ControlError("INVALID_INPUT", issues.join("; "));
}

export function controlErrorDetails(error: unknown) {
  if (!(error instanceof Error))
    return { code: "INTERNAL_ERROR", message: "操作失败。" };
  const details = error as Error & { code?: unknown; statusCode?: unknown };
  return {
    code: typeof details.code === "string" ? details.code : "INTERNAL_ERROR",
    message: error.message,
    ...(typeof details.statusCode === "number"
      ? { statusCode: details.statusCode }
      : {}),
  };
}
