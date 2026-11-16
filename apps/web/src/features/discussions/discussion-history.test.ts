import { describe, expect, it } from "vitest";
import type { DiscussionMessage } from "@loopmarshal/protocol";
import { mergeDiscussionMessages } from "./discussion-history";

const message = (i: number): DiscussionMessage => ({
  id: String(i),
  roomId: "room",
  speaker: "member",
  content: String(i),
  status: "complete",
  createdAt: "now",
});
describe("discussion history across moving latest pages", () => {
  it("keeps every loaded message after another round moves the latest 100-message window", () => {
    const initial = Array.from({ length: 104 }, (_, i) => message(i));
    const loaded = mergeDiscussionMessages(
      initial.slice(0, 4),
      initial.slice(4),
    );
    const nextPage = Array.from({ length: 100 }, (_, i) => message(i + 6));
    const merged = mergeDiscussionMessages(loaded, nextPage);
    expect(merged).toHaveLength(106);
    expect(merged.map((m) => m.id)).toEqual(
      Array.from({ length: 106 }, (_, i) => String(i)),
    );
  });
  it("updates a pending reply without duplicates or reordering history", () => {
    const pending = { ...message(1), content: "thinking", status: "pending" };
    const merged = mergeDiscussionMessages(
      [message(0), pending, message(2)],
      [message(1), message(2), message(3)],
    );
    expect(merged.map((m) => m.id)).toEqual(["0", "1", "2", "3"]);
    expect(merged[1]?.status).toBe("complete");
  });
});
