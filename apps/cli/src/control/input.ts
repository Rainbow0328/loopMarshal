import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { ControlError } from "./errors.js";

export type InputOptions = { input?: string; inputFile?: string };
export const MAX_CONTROL_INPUT_BYTES = 2 * 1024 * 1024;

async function readBounded(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    assertInputSize(bytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertInputSize(bytes: number): void {
  if (bytes > MAX_CONTROL_INPUT_BYTES)
    throw new ControlError("INVALID_INPUT", "JSON 输入不能超过 2 MB。");
}

export async function readControlInput(
  options: InputOptions,
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<unknown> {
  if (options.input !== undefined && options.inputFile !== undefined)
    throw new ControlError(
      "INVALID_INPUT",
      "--input 和 --input-file 只能选择一个。",
    );
  let raw = options.input ?? "{}";
  if (options.inputFile === "-") {
    if (stdin.isTTY)
      throw new ControlError(
        "INVALID_INPUT",
        "--input-file - 需要从标准输入传入 JSON。",
      );
    raw = await readBounded(stdin);
  } else if (options.inputFile !== undefined) {
    const file = await open(options.inputFile, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new ControlError("INVALID_INPUT", "JSON 输入必须是普通文件。");
      assertInputSize(stat.size);
      // The streaming limit also protects against files that grow after stat().
      raw = await readBounded(file.createReadStream({ autoClose: false }));
    } finally {
      await file.close();
    }
  }
  assertInputSize(Buffer.byteLength(raw));
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new ControlError(
      "INVALID_INPUT",
      "输入必须为合法 JSON。复杂内容或密钥建议使用 --input-file <文件> 或 --input-file -。",
    );
  }
}
