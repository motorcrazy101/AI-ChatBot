import axios from "axios";
import { config } from "./config";
import { ConversationMessage, KindroidResponse, KindroidAIResult } from "./types";

/**
 * Turns a display name into a short alphanumeric ID for the
 * X-Kindroid-Requester header (handles non-ASCII names).
 */
function requesterId(username: string): string {
  return Buffer.from(encodeURIComponent(username))
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 32);
}

/**
 * Packs replies tighter for Discord: removes the blank lines between
 * paragraphs (keeping each action/line on its own line) and stray spaces.
 */
export function tidyReply(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Calls the Kindroid AI inference endpoint.
 * Returns { type: "rate_limited" } on HTTP 429, throws on any other failure.
 */
export async function callKindroidAI(
  sharedAiCode: string,
  conversation: ConversationMessage[],
  enableFilter = false
): Promise<KindroidAIResult> {
  try {
    return await requestKindroid(sharedAiCode, conversation, enableFilter);
  } catch (error) {
    if (!(error instanceof KindroidError) || error.status === undefined) throw error;
    // Kindroid sometimes rejects a conversation it doesn't like (fancy names,
    // very long messages...). Try once more with a smaller, simpler version.
    const simple = simplifyConversation(conversation);
    try {
      const result = await requestKindroid(sharedAiCode, simple, enableFilter);
      console.warn(`[kindroid] First request was rejected (${error.message}); the simplified retry worked.`);
      return result;
    } catch (retryError) {
      console.error(
        `[kindroid] Request rejected twice (${error.message}). If this happens on EVERY message, check ` +
          "SHARED_AI_CODE_1 (it must be a share code from your own account that's still shared) and KINDROID_API_KEY in Railway."
      );
      throw retryError;
    }
  }
}

class KindroidError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Last few messages, plain-letter names and shorter texts. */
export function simplifyConversation(conversation: ConversationMessage[]): ConversationMessage[] {
  const plainName = (name: string) => {
    if (name === "{{ai}}" || name === "Server") return name;
    const cleaned = name.normalize("NFKC").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim();
    return (cleaned || "Resident").slice(0, 32);
  };
  return conversation.slice(-12).map((m) => ({
    username: plainName(m.username),
    text: m.text.length > 1500 ? `${m.text.slice(0, 1499)}…` : m.text,
    ...(m.timestamp ? { timestamp: m.timestamp } : {}),
  }));
}

async function requestKindroid(
  sharedAiCode: string,
  conversation: ConversationMessage[],
  enableFilter: boolean
): Promise<KindroidAIResult> {
  if (conversation.length === 0) {
    throw new Error("Conversation array cannot be empty");
  }

  const lastUsername = conversation[conversation.length - 1].username;

  try {
    const { data } = await axios.post<KindroidResponse>(
      config.kindroidUrl,
      { share_code: sharedAiCode, conversation, enable_filter: enableFilter },
      {
        timeout: config.requestTimeoutMs,
        headers: {
          Authorization: `Bearer ${config.kindroidApiKey}`,
          "X-Kindroid-Requester": requesterId(lastUsername),
          "Content-Type": "application/json",
        },
      }
    );

    if (!data.success || typeof data.reply !== "string") {
      throw new KindroidError(data.error || "Kindroid API returned no reply", 200);
    }

    return { type: "success", reply: tidyReply(data.reply) };
  } catch (error) {
    if (axios.isAxiosError<KindroidResponse>(error)) {
      const status = error.response?.status;
      if (status === 429) {
        console.warn("Kindroid API rate limited (429)");
        return { type: "rate_limited" };
      }
      if (error.code === "ECONNABORTED") {
        throw new Error(`Kindroid API timed out after ${config.requestTimeoutMs}ms`);
      }
      const body = error.response?.data as unknown;
      const detail =
        (body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null) ??
        (typeof body === "string" && body ? body.slice(0, 300) : error.message);
      throw new KindroidError(`Kindroid API error${status ? ` (${status})` : ""}: ${detail}`, status);
    }
    throw error;
  }
}
