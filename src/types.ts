export interface BotConfig {
  id: string;
  discordBotToken: string;
  sharedAiCode: string;
  enableFilter: boolean;
}

export interface ConversationMessage {
  username: string;
  text: string;
  timestamp?: string;
}

export interface KindroidResponse {
  success: boolean;
  reply: string;
  stop_reason?: string | null;
  error?: string;
}

export type KindroidAIResult =
  | { type: "success"; reply: string }
  | { type: "rate_limited" };
