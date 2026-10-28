import {
  ChannelType,
  Client,
  DMChannel,
  GuildTextBasedChannel,
  GatewayIntentBits,
  Message,
  Partials,
  PermissionFlagsBits,
} from "discord.js";
import { config } from "./config";
import { botChainTooLong, pruneChains, recordMessage } from "./botChain";
import { logIncoming, logOutgoing } from "./chatLog";
import { callKindroidAI } from "./kindroidAPI";
import { fetchConversation } from "./messageFetch";
import { BotConfig } from "./types";

const DISCORD_MAX_LENGTH = 2000;
const TYPING_REFRESH_MS = 8000; // Discord's typing indicator lasts ~10s

const activeBots = new Map<string, Client>();

type ReplyChannel = GuildTextBasedChannel | DMChannel;

// ---------- helpers ----------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `name` appears in `text` as a whole word (works with non-English names). */
function containsName(text: string, name: string): boolean {
  if (!name) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`,
    "iu"
  );
  return pattern.test(text);
}

/** Splits a long reply into Discord-sized pieces, preferring line/word breaks. */
function splitMessage(text: string, max = DISCORD_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function hasRequiredPermissions(message: Message): boolean {
  const { channel, guild } = message;
  if (channel.isDMBased()) return true;

  const me = guild?.members.me;
  if (!me) return false;

  const permissions = channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
  ];
  return !!permissions?.has(required);
}

/** Should this bot answer this message? */
function isAddressedToBot(message: Message, client: Client<true>): boolean {
  if (message.channel.type === ChannelType.DM) return true;

  const botId = client.user.id;
  if (message.mentions.users.has(botId)) return true;
  if (message.mentions.repliedUser?.id === botId) return true; // reply without @ping

  const names = new Set([
    client.user.username,
    client.user.globalName ?? "",
    message.guild?.members.me?.displayName ?? "",
  ]);
  return [...names].some((name) => containsName(message.content, name));
}

/** Shows "Bot is typing..." until the returned stop function is called. */
function startTyping(channel: ReplyChannel, botId: string): () => void {
  const send = () =>
    channel.sendTyping().catch((err) =>
      console.warn(`[${botId}] Failed to send typing indicator:`, err.message)
    );
  void send();
  const interval = setInterval(send, TYPING_REFRESH_MS);
  return () => clearInterval(interval);
}

/** Sends text as a reply (first chunk) and follow-up messages for the rest. */
async function sendReply(
  message: Message,
  channel: ReplyChannel,
  text: string
): Promise<Message[]> {
  const chunks = splitMessage(text);
  if (chunks.length === 0) return [];

  // Never let the AI ping @everyone, @here, roles or random users.
  const allowedMentions = { parse: [], repliedUser: true };

  const sent: Message[] = [];
  sent.push(await message.reply({ content: chunks[0], allowedMentions }));
  for (const chunk of chunks.slice(1)) {
    const followUp: Message = await channel.send({ content: chunk, allowedMentions });
    sent.push(followUp);
  }
  return sent;
}

// ---------- main handler ----------

async function handleMessage(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig
): Promise<void> {
  recordMessage(message); // count our own messages too, for the bot-chain limit
  if (message.author.id === client.user.id) return;

  if (message.author.bot) {
    // Ignore bots in DMs, and stop endless bot-to-bot conversations.
    if (message.channel.isDMBased()) return;
    if (botChainTooLong(message.channelId, config.maxBotChain)) return;
  }

  if (!isAddressedToBot(message, client)) return;
  if (!hasRequiredPermissions(message)) return;

  if (message.channel.type === ChannelType.GroupDM) return;
  const channel = message.channel as ReplyChannel;

  const botName = message.guild?.members.me?.displayName ?? client.user.displayName;
  logIncoming(botConfig.id, botName, message);

  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const conversation = await fetchConversation(
      channel,
      client.user.id,
      config.contextMessageLimit
    );
    if (conversation.length === 0) return;

    const result = await callKindroidAI(
      botConfig.sharedAiCode,
      conversation,
      botConfig.enableFilter
    );

    stopTyping();
    if (result.type === "rate_limited") return;

    const sent = await sendReply(message, channel, result.reply);
    for (const reply of sent) logOutgoing(botConfig.id, botName, reply, message);
  } catch (error) {
    stopTyping();
    console.error(`[${botConfig.id}] Error handling message ${message.id}:`, error);
    await message
      .reply({ content: config.errorMessage, allowedMentions: { parse: [] } })
      .catch((err) =>
        console.error(`[${botConfig.id}] Could not send error message:`, err.message)
      );
  } finally {
    stopTyping();
  }
}

// ---------- lifecycle ----------

async function createBot(botConfig: BotConfig): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", (ready) => {
    console.log(`[${botConfig.id}] Logged in as ${ready.user.tag}`);
  });

  client.on("messageCreate", (message) => {
    if (!client.isReady()) return;
    handleMessage(message, client, botConfig).catch((err) =>
      console.error(`[${botConfig.id}] Unhandled error:`, err)
    );
  });

  client.on("error", (error) => {
    console.error(`[${botConfig.id}] Client error:`, error);
  });

  await client.login(botConfig.discordBotToken);
  activeBots.set(botConfig.id, client);
  return client;
}

export async function initializeAllBots(botConfigs: BotConfig[]): Promise<number> {
  console.log(`Starting ${botConfigs.length} bot(s)...`);

  const results = await Promise.allSettled(botConfigs.map(createBot));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`[${botConfigs[i].id}] Failed to log in:`, result.reason);
    }
  });

  setInterval(pruneChains, 15 * 60 * 1000).unref();

  const started = results.filter((r) => r.status === "fulfilled").length;
  console.log(`${started}/${botConfigs.length} bot(s) online`);
  return started;
}

export async function shutdownAllBots(): Promise<void> {
  console.log("Shutting down all bots...");
  await Promise.allSettled(
    [...activeBots.entries()].map(async ([id, client]) => {
      await client.destroy();
      console.log(`[${id}] Disconnected`);
    })
  );
  activeBots.clear();
}
