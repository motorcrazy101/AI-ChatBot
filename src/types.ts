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

export type ReplyLength = "short" | "medium" | "long" | "off";

/** Something the owner told her to remember. userId null = a general fact. */
export interface MemoryFact {
  id: number;
  userId: string | null;
  /** The person's name when the memory was saved. */
  userName: string | null;
  fact: string;
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
  /** Sleep schedule: "HH:MM" times in TIMEZONE. */
  sleep: { enabled: boolean; bedtime: string; wake: string };
  /** guildId -> channelId where birthday wishes are posted. */
  birthdayChannels: Record<string, string>;
  /** How long her replies can be. */
  replyLength: ReplyLength;
  /** Owner-set memories about people (or general facts). */
  memories: MemoryFact[];
  nextMemoryId: number;
  /** userId -> other names people use for them, e.g. ["douche"]. */
  nicknames: Record<string, string[]>;
}
