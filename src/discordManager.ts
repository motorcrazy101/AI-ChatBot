import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  Partials,
} from "discord.js";
import { config } from "./config";
import { botChainTooLong, pruneChains, recordMessage } from "./botChain";
import { logBotPost, logIncoming, logOutgoing } from "./chatLog";
import { handleCommand, registerCommands } from "./commands";
import { applyStatus, parseStatus } from "./presence";
import {
  botDisplayName,
  canPostIn,
  generateReply,
  randomPercent,
  ReplyChannel,
  sendText,
  startTyping,
} from "./respond";
import { startScheduler } from "./scheduler";
import { getSettings, settingsLoaded } from "./settings";
import { welcomeMember } from "./welcome";
import { BotConfig } from "./types";

const activeBots = new Map<string, Client>();

/** Last random chime-in per bot+channel, for the cooldown. */
const lastChimeIn = new Map<string, number>();

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

/** React to a message with a random emoji from the bot's list. */
async function reactRandomly(message: Message, botConfig: BotConfig): Promise<void> {
  const emojis = getSettings(botConfig.id).reactionEmojis;
  if (emojis.length === 0) return;
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  await message.react(emoji).catch((err) =>
    console.warn(`[${botConfig.id}] Could not react with ${emoji}:`, err.message)
  );
}

function chimeInCooldownOver(botId: string, channelId: string): boolean {
  const last = lastChimeIn.get(`${botId}:${channelId}`) ?? 0;
  return Date.now() - last > config.chimeCooldownMinutes * 60_000;
}

// ---------- main handler ----------

async function handleMessage(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig
): Promise<void> {
  recordMessage(message); // count our own messages too, for the bot-chain limit
  if (message.author.id === client.user.id) return;

  const settings = getSettings(botConfig.id);
  if (settings.blockedUsers.includes(message.author.id)) return;
  if (settings.quietChannels.includes(message.channelId)) return;

  if (message.author.bot) {
    // Ignore bots in DMs, and stop endless bot-to-bot conversations.
    if (message.channel.isDMBased()) return;
    if (botChainTooLong(message.channelId, config.maxBotChain)) return;
  }

  if (message.channel.type === ChannelType.GroupDM) return;
  const channel = message.channel as ReplyChannel;
  if (!canPostIn(channel)) return;

  const addressed = isAddressedToBot(message, client);

  // Not talking to her: maybe chime in or react in chime-in channels.
  let chimingIn = false;
  if (!addressed) {
    if (message.author.bot || !message.inGuild()) return;
    if (!settings.chimeChannels.includes(message.channelId)) return;
    if (!message.content.trim()) return;

    if (
      chimeInCooldownOver(botConfig.id, message.channelId) &&
      randomPercent(settings.chimeChance)
    ) {
      chimingIn = true;
      lastChimeIn.set(`${botConfig.id}:${message.channelId}`, Date.now());
    } else {
      if (randomPercent(settings.reactionChance)) await reactRandomly(message, botConfig);
      return;
    }
  }

  const botName = botDisplayName(client, channel);
  if (!chimingIn) logIncoming(botConfig.id, botName, message);

  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const reply = await generateReply(client, botConfig, channel);
    stopTyping();
    if (!reply) return;

    if (chimingIn) {
      const sent = await sendText(channel, reply);
      for (const post of sent) logBotPost(botConfig.id, botName, post, "chime-in");
      return;
    }

    const sent = await sendText(channel, reply, { replyTo: message });
    for (const post of sent) logOutgoing(botConfig.id, botName, post, message);

    // Sometimes add a reaction on top of the reply.
    if (randomPercent(settings.reactionChance)) await reactRandomly(message, botConfig);
  } catch (error) {
    stopTyping();
    console.error(`[${botConfig.id}] Error handling message ${message.id}:`, error);
    if (chimingIn) return; // nobody asked, so don't post an error
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

const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
];

function isDisallowedIntentsError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown };
  return (
    err?.code === "DisallowedIntents" ||
    (typeof err?.message === "string" && /disallowed intents|privileged intent/i.test(err.message))
  );
}

function buildClient(botConfig: BotConfig, withMembers: boolean): Client {
  const client = new Client({
    intents: withMembers ? [...BASE_INTENTS, GatewayIntentBits.GuildMembers] : BASE_INTENTS,
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", (ready) => {
    console.log(`[${botConfig.id}] Logged in as ${ready.user.tag}`);

    void registerCommands(ready, botConfig);
    startScheduler(client, botConfig);

    // Apply the status once saved settings are loaded.
    void settingsLoaded().then(() => {
      const saved = getSettings(botConfig.id).status;
      applyStatus(ready, saved ?? parseStatus(botConfig.defaultStatus));
    });
  });

  client.on("messageCreate", (message) => {
    if (!client.isReady()) return;
    handleMessage(message, client, botConfig).catch((err) =>
      console.error(`[${botConfig.id}] Unhandled error:`, err)
    );
  });

  client.on("interactionCreate", (interaction) => {
    if (!client.isReady() || !interaction.isChatInputCommand()) return;
    handleCommand(interaction, client, botConfig).catch((err) =>
      console.error(`[${botConfig.id}] Command error:`, err)
    );
  });

  client.on("guildMemberAdd", (member) => {
    if (!client.isReady()) return;
    if (member.user.bot) return;
    welcomeMember(member, client, botConfig).catch((err) =>
      console.error(`[${botConfig.id}] Welcome failed:`, err)
    );
  });

  client.on("error", (error) => {
    console.error(`[${botConfig.id}] Client error:`, error);
  });

  return client;
}

async function createBot(botConfig: BotConfig): Promise<Client> {
  // Welcoming new members needs the "Server Members Intent" switched on in
  // the Discord Developer Portal. If it isn't, log in without it instead of
  // failing, and explain how to turn it on.
  let client = buildClient(botConfig, true);
  try {
    await client.login(botConfig.discordBotToken);
  } catch (error) {
    if (!isDisallowedIntentsError(error)) throw error;
    console.warn(
      `[${botConfig.id}] "Server Members Intent" is off in the Discord Developer Portal, ` +
        "so welcoming new members is disabled. Turn it on under Bot → Privileged Gateway Intents."
    );
    await client.destroy();
    client = buildClient(botConfig, false);
    await client.login(botConfig.discordBotToken);
  }
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
