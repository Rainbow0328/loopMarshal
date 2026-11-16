import type { DiscussionMessage } from "@loopmarshal/protocol";

/** Preserve loaded history when the latest page moves, replacing pending replies in place. */
export function mergeDiscussionMessages(
  ...pages: DiscussionMessage[][]
): DiscussionMessage[] {
  return Array.from(
    new Map(pages.flat().map((message) => [message.id, message])).values(),
  );
}
