import type { MessageRecord } from "@loopmarshal/protocol";

export function payloadRecord(message: MessageRecord): Record<string, unknown> {
  return message.payload &&
    typeof message.payload === "object" &&
    !Array.isArray(message.payload)
    ? (message.payload as Record<string, unknown>)
    : {};
}
export function isUserMessage(message: MessageRecord) {
  return payloadRecord(message).kind === "web_user_message";
}

/** Collaboration messages remain in history; only the user's conversation is shown here. */
export function userHostConversation(
  messages: MessageRecord[],
  hostId?: string,
): MessageRecord[] {
  if (!hostId) return [];
  const inputs = new Map(
    messages
      .filter(
        (message) =>
          message.fromAgentId === hostId &&
          message.toAgentId === hostId &&
          isUserMessage(message),
      )
      .map((message) => [message.id, message]),
  );
  return messages.filter((message) => {
    if (inputs.has(message.id)) return true;
    if (
      message.fromAgentId !== hostId ||
      (message.toAgentId && message.toAgentId !== hostId) ||
      !["result", "progress", "error"].includes(message.type)
    )
      return false;
    const payload = payloadRecord(message);
    if (payload.kind === "host_reply") return true;
    // Older proxy reports retain their explicit source link. Do not guess that
    // every Host broadcast or Worker result is a reply to the user.
    const sourceId = payload.inReplyTo ?? payload.inReplyToMessageId;
    return (
      (typeof sourceId === "string" && inputs.has(sourceId)) ||
      Boolean(message.correlationId && inputs.has(message.correlationId))
    );
  });
}
