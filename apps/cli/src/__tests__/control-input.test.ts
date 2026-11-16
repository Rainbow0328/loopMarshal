import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONTROL_INPUT_BYTES, readControlInput } from "../control/input.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("bounded JSON input", () => {
  it("accepts inline JSON, empty defaults, and UTF-8 BOM files", async () => {
    expect(await readControlInput({})).toEqual({});
    expect(await readControlInput({ input: '{"content":"你好"}' })).toEqual({
      content: "你好",
    });
    const root = await mkdtemp(join(tmpdir(), "control-input-"));
    roots.push(root);
    const file = join(root, "input.json");
    await writeFile(file, '\uFEFF{"session":"项目协作"}');
    expect(await readControlInput({ inputFile: file })).toEqual({
      session: "项目协作",
    });
  });

  it("reassembles multibyte characters split across stdin buffers", async () => {
    const bytes = Buffer.from('{"content":"你好"}');
    const input = Readable.from([...bytes].map((b) => Buffer.from([b])));
    expect(await readControlInput({ inputFile: "-" }, input)).toEqual({
      content: "你好",
    });
  });

  it("rejects oversized files and streams before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-input-"));
    roots.push(root);
    const file = join(root, "large.json");
    await writeFile(file, Buffer.alloc(MAX_CONTROL_INPUT_BYTES + 1));
    await expect(readControlInput({ inputFile: file })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const input = Readable.from([
      Buffer.alloc(MAX_CONTROL_INPUT_BYTES),
      Buffer.from("x"),
    ]);
    await expect(readControlInput({ inputFile: "-" }, input)).rejects.toThrow(
      "2 MB",
    );
    await expect(
      readControlInput({ input: "你".repeat(MAX_CONTROL_INPUT_BYTES / 2) }),
    ).rejects.toThrow("2 MB");
  });

  it("rejects conflicting sources, interactive stdin and directories", async () => {
    await expect(
      readControlInput({ input: "{}", inputFile: "anything" }),
    ).rejects.toThrow("只能选择一个");
    const input = Object.assign(Readable.from([]), { isTTY: true });
    await expect(readControlInput({ inputFile: "-" }, input)).rejects.toThrow(
      "标准输入",
    );
    const root = await mkdtemp(join(tmpdir(), "control-input-"));
    roots.push(root);
    await expect(readControlInput({ inputFile: root })).rejects.toThrow(
      "普通文件",
    );
  });

  it("never includes malformed JSON in errors", async () => {
    await expect(
      readControlInput({ input: '{"apiKey":"private-secret"' }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.not.stringContaining("private-secret"),
    });
  });
});
