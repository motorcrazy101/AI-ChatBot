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
import { addAffection, AffectionChange, checkIn, isGreeting } from "./affection";
import { startAnimeAlertLoop } from "./animeAlerts";
import { startAnniversaryLoop, startBirthdayLoop } from "./birthdays";
import { handleCommand, registerCommands } from "./commands";
import { handleConfessionButton, handleConfessionDm } from "./confessions";
import { FeatureContext, stripBotName } from "./featureKit";
import { runFeatures } from "./features";
import { loadOwners } from "./memory";
import { liftMood } from "./mood";
import { startPollLoop } from "./polls";
import { planIncomingGif, planReplyGif, replyWithGif } from "./reactionGifs";
import { checkTriviaAnswer } from "./games";
import { handleImageRequest, parseImageRequest } from "./imageSearch";
import { refreshPresence } from "./presence";
import {
  botDisplayName,
  canPostIn,
  generateReply,
  randomPercent,
  ReplyChannel,
  sendText,
  startTyping,
} from "./respond";
import { startReminderLoop } from "./reminders";
import { startScheduler } from "./scheduler";
import { handleStoryMessage, startStoryLoop } from "./storyGames";
import { currentPhase } from "./sleep";
import { addDays, zonedParts } from "./time";
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
function isAddressedToBot(message: Message, client: Client<true>, botConfig: BotConfig): boolean {
  if (message.channel.type === ChannelType.DM) return true;

  const botId = client.user.id;
  const repliesOff =
    !!message.guildId && getSettings(botConfig.id).repliesOffGuilds.includes(message.guildId);

  if (repliesOff) {
    // Replying to her doesn't count (Discord adds a ping to replies automatically),
    // so only an @mention typed into the message itself does.
    if (message.content.includes(`<@${botId}>`) || message.content.includes(`<@!${botId}>`)) return true;
  } else {
    if (message.mentions.users.has(botId)) return true;
    if (message.mentions.repliedUser?.id === botId) return true; // reply without @ping
  }

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

  const user = { id: message.author.id, name: message.member?.displayName ?? message.author.displayName };

  // Trivia guesses ("b", "c"...) can come from anyone in the channel.
  if (await checkTriviaAnswer(message, user.name, botConfig.id)) return;

  const addressed = isAddressedToBot(message, client, botConfig);
  const botName = botDisplayName(client, channel);
  const text = stripBotName(message.cleanContent, [client.user.username, client.user.globalName ?? "", botName]);

  // Story games (adventure votes, Secret File questions, logbook lines, roleplay
  // scenes) react to messages in their thread even without her name.
  try {
    if (await handleStoryMessage(message, client, botConfig, user, botName, text, addressed)) return;
  } catch (error) {
    console.error(`[${botConfig.id}] Story game message failed:`, error);
  }

  // Not talking to her: maybe chime in or react in chime-in channels (not while she's asleep).
  let chimingIn = false;
  if (!addressed) {
    if (message.author.bot || !message.inGuild()) return;
    if (!settings.chimeChannels.includes(message.channelId)) return;
    if (!message.content.trim()) return;
    if (currentPhase(botConfig.id) === "asleep") return;

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

  const fromPerson = !chimingIn && !message.author.bot;

  // "confess: ..." in a DM → anonymous confession (not saved in the chat log).
  if (fromPerson && channel.isDMBased()) {
    try {
      if (await handleConfessionDm(message, client, botConfig)) return;
    } catch (error) {
      console.error(`[${botConfig.id}] Confession failed:`, error);
      await message.reply("Something went wrong with that confession 😣 Try again later.").catch(() => undefined);
      return;
    }
  }

  if (!chimingIn) logIncoming(botConfig.id, botName, message);

  // Talking to her slowly raises your affection level and cheers her up.
  const affection = fromPerson ? await addAffection(botConfig.id, user, "chat") : null;
  if (fromPerson) liftMood(botConfig.id, 1);

  // Daily good morning / good night streaks.
  const extraNotes: string[] = [];
  let streakMilestone: number | null = null;
  if (fromPerson && isGreeting(text)) {
    const now = zonedParts();
    const [y, m, d] = addDays(now.year, now.month, now.day, -1);
    const yesterday = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const streak = await checkIn(botConfig.id, user, now.date, yesterday);
    if (streak.counted) {
      liftMood(botConfig.id, 2);
      if (streak.milestone) {
        streakMilestone = streak.streak;
        extraNotes.push(
          `${user.name} has greeted you ${streak.streak} days in a row — that's a milestone! Celebrate it in your reply.`
        );
      } else if (streak.streak >= 2) {
        extraNotes.push(`${user.name} has greeted you ${streak.streak} days in a row (you can mention the streak).`);
      } else if (streak.broken) {
        extraNotes.push(`${user.name} had a ${streak.broken}-day streak of greeting you but missed a day — tease them a little.`);
      }
    }
  }

  // Features: reminders, birthdays, weather, games, anime lookup, pictures...
  if (fromPerson) {
    try {
      const ctx: FeatureContext = {
        message,
        channel,
        client,
        botConfig,
        botName,
        user,
        text,
      };
      let handled = await runFeatures(ctx);
      if (!handled) {
        const imageRequest = parseImageRequest(message.cleanContent);
        if (imageRequest) {
          await handleImageRequest(message, channel, imageRequest, client, botConfig);
          handled = true;
        }
      }
      if (handled) {
        await announceLevelUp(channel, botConfig, botName, user, affection);
        return;
      }
    } catch (error) {
      console.error(`[${botConfig.id}] Feature failed for message ${message.id}:`, error);
      await message
        .reply({ content: config.errorMessage, allowedMentions: { parse: [] } })
        .catch(() => undefined);
      return;
    }
  }

  // Reaction GIFs: hugging back "*hugs aurora*", or self-defense if someone is mean to her.
  const incomingGif = fromPerson
    ? planIncomingGif(
        botConfig.id,
        message.content,
        [client.user.username, client.user.globalName ?? "", botName],
        user,
        affection?.after.level ?? 0
      )
    : null;
  if (incomingGif?.note) extraNotes.push(incomingGif.note);

  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const reply = await generateReply(client, botConfig, channel, undefined, fromPerson ? user : undefined, extraNotes);
    stopTyping();
    if (!reply) return;

    // Attach a GIF (theirs to answer, or now and then one that matches her reply).
    const gifPlan = !chimingIn && fromPerson ? incomingGif ?? planReplyGif(botConfig.id, reply, user.name) : null;
    let sentWithGif = false;
    if (gifPlan && reply.length <= 2000) {
      const withGif = await replyWithGif(message, reply, gifPlan, botName).catch(() => null);
      if (withGif) {
        logOutgoing(botConfig.id, botName, withGif, message, `${reply}\n[gif] ${gifPlan.action.key}`);
        sentWithGif = true;
      }
    }

    if (chimingIn) {
      const sent = await sendText(channel, reply);
      for (const post of sent) logBotPost(botConfig.id, botName, post, "chime-in");
      return;
    }

    if (!sentWithGif) {
      const sent = await sendText(channel, reply, { replyTo: message });
      for (const post of sent) logOutgoing(botConfig.id, botName, post, message);
    }

    await announceLevelUp(channel, botConfig, botName, user, affection);
    if (streakMilestone) {
      await channel
        .send({ content: `🔥 **${user.name}** is on a **${streakMilestone}-day** streak with ${botName}!`, allowedMentions: { parse: [] } })
        .catch(() => undefined);
    }

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

/** "💛 Mike and Aurora are now Close Friends!" when someone levels up. */
async function announceLevelUp(
  channel: ReplyChannel,
  botConfig: BotConfig,
  botName: string,
  user: { id: string; name: string },
  change: AffectionChange | null
): Promise<void> {
  if (!change || change.after.level <= change.before.level) return;
  const sent = await channel
    .send({
      content: `${change.after.emoji} **${user.name}** and **${botName}** are now **${change.after.name}s**!`,
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (sent) logBotPost(botConfig.id, botName, sent, "level-up");
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

function buildClient(botConfig: BotConfig, withMembers: boolean, withPresences: boolean): Client {
  const client = new Client({
    intents: [
      ...BASE_INTENTS,
      ...(withMembers ? [GatewayIntentBits.GuildMembers] : []),
      ...(withPresences ? [GatewayIntentBits.GuildPresences] : []),
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", (ready) => {
    console.log(`[${botConfig.id}] Logged in as ${ready.user.tag}`);

    void registerCommands(ready, botConfig);
    void loadOwners(ready, botConfig.id);
    startScheduler(client, botConfig);
    startReminderLoop(client, botConfig);
    startBirthdayLoop(client, botConfig);
    startAnniversaryLoop(client, botConfig);
    startPollLoop(client, botConfig);
    startAnimeAlertLoop(client, botConfig);
    startStoryLoop(client, botConfig);

    // Apply the status once saved settings are loaded, then keep it in sync
    // with the sleep schedule (😴 Sleeping at night, ☕ Just woke up...).
    void settingsLoaded().then(() => refreshPresence(ready, botConfig, true));
    setInterval(() => {
      if (client.isReady()) refreshPresence(client, botConfig);
    }, 60_000).unref();
  });

  client.on("messageCreate", (message) => {
    if (!client.isReady()) return;
    handleMessage(message, client, botConfig).catch((err) =>
      console.error(`[${botConfig.id}] Unhandled error:`, err)
    );
  });

  client.on("interactionCreate", (interaction) => {
    if (!client.isReady()) return;
    if (interaction.isButton()) {
      handleConfessionButton(interaction, client, botConfig).catch((err) =>
        console.error(`[${botConfig.id}] Button error:`, err)
      );
      return;
    }
    if (!interaction.isChatInputCommand()) return;
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

/**
 * Optional "privileged" features need switches in the Discord Developer Portal
 * (Bot → Privileged Gateway Intents):
 *   Server Members Intent → welcoming new members
 *   Presence Intent       → noticing what people are playing / listening to
 * If one is off, log in without it instead of failing, and say how to turn it on.
 */
const INTENT_ATTEMPTS: { members: boolean; presences: boolean }[] = [
  { members: true, presences: true },
  { members: true, presences: false },
  { members: false, presences: true },
  { members: false, presences: false },
];

async function createBot(botConfig: BotConfig): Promise<Client> {
  let lastError: unknown;
  for (const attempt of INTENT_ATTEMPTS) {
    const client = buildClient(botConfig, attempt.members, attempt.presences);
    try {
      await client.login(botConfig.discordBotToken);
      if (!attempt.members) {
        console.warn(
          `[${botConfig.id}] "Server Members Intent" is off in the Discord Developer Portal, so welcoming new ` +
            "members is disabled. Turn it on under Bot → Privileged Gateway Intents."
        );
      }
      if (!attempt.presences) {
        console.warn(
          `[${botConfig.id}] "Presence Intent" is off in the Discord Developer Portal, so she can't see what ` +
            "people are playing or listening to. Turn it on under Bot → Privileged Gateway Intents."
        );
      }
      activeBots.set(botConfig.id, client);
      return client;
    } catch (error) {
      await client.destroy().catch(() => undefined);
      if (!isDisallowedIntentsError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
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
