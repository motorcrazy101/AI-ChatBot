export interface BotConfig {
  id: string;
  discordBotToken: string;
  sharedAiCode: string;
  enableFilter: boolean;
  /** Status from BOT_STATUS_N, e.g. "Playing in the Asylum". Used until changed with a command. */
  defaultStatus: string;
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

export type StatusType = "playing" | "watching" | "listening" | "competing" | "custom";

export interface StatusSetting {
  type: StatusType;
  /** Empty text = no status. */
  text: string;
}

export type ScheduleDays =
  | "daily"
  | "weekdays"
  | "weekends"
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun";

export interface ScheduledPost {
  id: number;
  guildId: string;
  channelId: string;
  /** 24-hour "HH:MM" in the bot's TIMEZONE. */
  time: string;
  days: ScheduleDays;
  /** What the bot should post about, e.g. "Say good morning to everyone". */
  prompt: string;
  /** "YYYY-MM-DD" of the last run, so it only posts once per day. */
  lastRunDate?: string;
}

export interface BotSettings {
  /** Channels where the bot says nothing at all. */
  quietChannels: string[];
  /** Users the bot always ignores. */
  blockedUsers: string[];
  /** Channels where the bot may randomly join conversations. */
  chimeChannels: string[];
  /** % chance to chime in on a message in a chime-in channel. */
  chimeChance: number;
  /** % chance to add an emoji reaction. */
  reactionChance: number;
  reactionEmojis: string[];
  /** guildId -> channelId where new members are welcomed. */
  welcomeChannels: Record<string, string>;
  schedules: ScheduledPost[];
  nextScheduleId: number;
  /** null = use BOT_STATUS_N from Railway variables. */
  status: StatusSetting | null;
}
