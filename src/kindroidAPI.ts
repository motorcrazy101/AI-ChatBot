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
 * Calls the Kindroid AI inference endpoint.
 * Returns { type: "rate_limited" } on HTTP 429, throws on any other failure.
 */
export async function callKindroidAI(
  sharedAiCode: string,
  conversation: ConversationMessage[],
  enableFilter = false
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
      throw new Error(data.error || "Kindroid API returned no reply");
    }

    return { type: "success", reply: data.reply };
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
      const detail = error.response?.data?.error ?? error.message;
      throw new Error(`Kindroid API error${status ? ` (${status})` : ""}: ${detail}`);
    }
    throw error;
  }
}
