import {
  ApplicationCommandDataResolvable,
  Guild,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  IntentsBitField,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config";
import { isDbReady, pool } from "./db";
import { levelFor, topAffection } from "./affection";
import { allBirthdays } from "./birthdays";
import { isOwner, MAX_FACT_LENGTH, MAX_MEMORIES } from "./memory";
import { describeStatus, parseStatus, refreshPresence } from "./presence";
import { DAY_LABELS, formatTime, parseTime, runScheduledPost } from "./scheduler";
import { getSettings, toggleInList, updateSettings } from "./settings";
import { currentPhase } from "./sleep";
import { MONTHS } from "./time";
import { BotConfig, ReplyLength, ScheduleDays, StatusType } from "./types";
import { welcomeMember } from "./welcome";

/**
 * One admin-only slash command per bot, named after the bot (Aurora -> /aurora).
 * Only people with the "Manage Server" permission can see and use it;
 * server owners can change who has access in Server Settings → Integrations.
 */

const MAX_SCHEDULES = 25;

export function commandName(client: Client<true>): string {
  const name = client.user.username
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return name || "bot";
}

const DAY_CHOICES = (Object.keys(DAY_LABELS) as ScheduleDays[]).map((value) => ({
  name: DAY_LABELS[value],
  value,
}));

const STATUS_CHOICES: { name: string; value: StatusType }[] = [
  { name: "Custom (just the text)", value: "custom" },
  { name: "Playing ...", value: "playing" },
  { name: "Watching ...", value: "watching" },
  { name: "Listening to ...", value: "listening" },
  { name: "Competing in ...", value: "competing" },
];

const POSTABLE_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

function buildCommand(name: string, botName: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`Control ${botName}`.slice(0, 100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("settings").setDescription("Show all current settings"))
    .addSubcommand((s) => s.setName("stats").setDescription("Who talks to her the most (last 30 days)"))
    .addSubcommand((s) => s.setName("quiet").setDescription("Stop talking in this channel"))
    .addSubcommand((s) => s.setName("unquiet").setDescription("Start talking in this channel again"))
    .addSubcommand((s) =>
      s
        .setName("block")
        .setDescription("Always ignore someone")
        .addUserOption((o) => o.setName("user").setDescription("Who to ignore").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("unblock")
        .setDescription("Stop ignoring someone")
        .addUserOption((o) => o.setName("user").setDescription("Who to unblock").setRequired(true))
    )
    .addSubcommand((s) => s.setName("blocklist").setDescription("Show everyone she ignores"))
    .addSubcommand((s) =>
      s
        .setName("length")
        .setDescription("How long her replies are")
        .addStringOption((o) =>
          o
            .setName("size")
            .setDescription("Reply length")
            .setRequired(true)
            .addChoices(
              { name: "Short (1-3 sentences)", value: "short" },
              { name: "Medium (a short paragraph)", value: "medium" },
              { name: "Long (a few paragraphs)", value: "long" },
              { name: "No limit", value: "off" }
            )
        )
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Change the status under her name (leave text empty to clear it)")
        .addStringOption((o) =>
          o.setName("text").setDescription("e.g. in the Asylum").setMaxLength(128)
        )
        .addStringOption((o) =>
          o.setName("type").setDescription("How it's shown").addChoices(...STATUS_CHOICES)
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("chimein")
        .setDescription("Let her randomly join conversations")
        .addSubcommand((s) => s.setName("on").setDescription("Allow random chime-ins in this channel"))
        .addSubcommand((s) => s.setName("off").setDescription("No random chime-ins in this channel"))
        .addSubcommand((s) =>
          s
            .setName("chance")
            .setDescription("How often she chimes in")
            .addNumberOption((o) =>
              o
                .setName("percent")
                .setDescription("Chance per message, 0-100 (default 5)")
                .setMinValue(0)
                .setMaxValue(100)
                .setRequired(true)
            )
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("reactions")
        .setDescription("Emoji reactions")
        .addSubcommand((s) =>
          s
            .setName("chance")
            .setDescription("How often she reacts with an emoji")
            .addNumberOption((o) =>
              o
                .setName("percent")
                .setDescription("Chance per message, 0-100 (0 turns reactions off)")
                .setMinValue(0)
                .setMaxValue(100)
                .setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("emojis")
            .setDescription("Which emojis she picks from")
            .addStringOption((o) =>
              o
                .setName("list")
                .setDescription("Emojis separated by spaces, e.g. ❤️ 😂 👀")
                .setRequired(true)
            )
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("welcome")
        .setDescription("Greet new members")
        .addSubcommand((s) =>
          s
            .setName("on")
            .setDescription("Welcome new members in a channel")
            .addChannelOption((o) =>
              o
                .setName("channel")
                .setDescription("Where to post (default: this channel)")
                .addChannelTypes(...POSTABLE_CHANNELS)
            )
        )
        .addSubcommand((s) => s.setName("off").setDescription("Stop welcoming new members"))
        .addSubcommand((s) => s.setName("test").setDescription("Post a test welcome for yourself"))
    )
    .addSubcommandGroup((g) =>
      g
        .setName("schedule")
        .setDescription("Scheduled posts")
        .addSubcommand((s) =>
          s
            .setName("add")
            .setDescription("Add a scheduled post")
            .addStringOption((o) =>
              o.setName("time").setDescription("e.g. 8am, 8:30 pm, 20:30").setRequired(true)
            )
            .addStringOption((o) =>
              o
                .setName("prompt")
                .setDescription("What to post about, e.g. Say good morning and ask how everyone slept")
                .setMaxLength(500)
                .setRequired(true)
            )
            .addChannelOption((o) =>
              o
                .setName("channel")
                .setDescription("Where to post (default: this channel)")
                .addChannelTypes(...POSTABLE_CHANNELS)
            )
            .addStringOption((o) =>
              o.setName("days").setDescription("Which days (default: every day)").addChoices(...DAY_CHOICES)
            )
        )
        .addSubcommand((s) => s.setName("list").setDescription("Show scheduled posts"))
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Delete a scheduled post")
            .addIntegerOption((o) =>
              o.setName("id").setDescription("Number from the list").setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("test")
            .setDescription("Post a scheduled message right now")
            .addIntegerOption((o) =>
              o.setName("id").setDescription("Number from the list").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("memory")
        .setDescription("Things she remembers about people (bot owner only)")
        .addSubcommand((s) =>
          s
            .setName("add")
            .setDescription("Teach her a fact (owner only)")
            .addStringOption((o) =>
              o
                .setName("fact")
                .setDescription("e.g. He's the Asylum Warden and she knows him personally")
                .setMaxLength(300)
                .setRequired(true)
            )
            .addUserOption((o) => o.setName("person").setDescription("Who it's about (leave empty for a general fact)"))
        )
        .addSubcommand((s) =>
          s
            .setName("nicknames")
            .setDescription("Other names people use for someone (owner only)")
            .addUserOption((o) => o.setName("person").setDescription("Who").setRequired(true))
            .addStringOption((o) =>
              o.setName("names").setDescription("Comma-separated, e.g. douche, the warden (empty = clear)")
            )
        )
        .addSubcommand((s) =>
          s
            .setName("list")
            .setDescription("Show what she remembers (owner only)")
            .addUserOption((o) => o.setName("person").setDescription("Only this person"))
        )
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Make her forget a fact (owner only)")
            .addIntegerOption((o) => o.setName("id").setDescription("Number from the list").setRequired(true))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("sleep")
        .setDescription("Her sleep schedule (😴 at night, sleepy replies if woken)")
        .addSubcommand((s) => s.setName("on").setDescription("Turn the sleep schedule on"))
        .addSubcommand((s) => s.setName("off").setDescription("Turn it off (she's always awake)"))
        .addSubcommand((s) =>
          s
            .setName("set")
            .setDescription("Change bedtime and wake-up time")
            .addStringOption((o) => o.setName("bedtime").setDescription("e.g. 11pm").setRequired(true))
            .addStringOption((o) => o.setName("wake").setDescription("e.g. 7am").setRequired(true))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("birthdays")
        .setDescription("Birthday wishes")
        .addSubcommand((s) =>
          s
            .setName("on")
            .setDescription("Post birthday wishes in a channel")
            .addChannelOption((o) =>
              o
                .setName("channel")
                .setDescription("Where to post (default: this channel)")
                .addChannelTypes(...POSTABLE_CHANNELS)
            )
        )
        .addSubcommand((s) => s.setName("off").setDescription("Stop posting birthday wishes here (DMs instead)"))
        .addSubcommand((s) => s.setName("list").setDescription("Show everyone's saved birthdays"))
    );
}

export async function registerCommands(client: Client<true>, botConfig: BotConfig): Promise<void> {
  const name = commandName(client);
  try {
    // The cast works around two copies of Discord's type definitions being
    // installed at slightly different versions; the data itself is identical.
    const command = buildCommand(name, client.user.displayName).toJSON() as unknown as ApplicationCommandDataResolvable;
    await client.application.commands.set([command]);
    console.log(`[${botConfig.id}] Slash command ready: /${name}`);
  } catch (err) {
    console.error(`[${botConfig.id}] Could not register /${name}:`, err);
  }
}

const channelMention = (id: string) => `<#${id}>`;
const userMention = (id: string) => `<@${id}>`;

const EMOJI_PATTERN = /^(<a?:\w+:\d+>|(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}‍️]+)$/u;

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  client: Client<true>,
  botConfig: BotConfig
): Promise<void> {
  if (interaction.commandName !== commandName(client)) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "This only works inside a server.", ephemeral: true });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const action = group ? `${group} ${sub}` : sub;

  // Stats are shown to everyone in the channel; everything else only to you.
  await interaction.deferReply({ ephemeral: action !== "stats" });
  const done = async (content: string) => {
    await interaction.editReply({ content: content.slice(0, 2000), allowedMentions: { parse: [] } });
  };

  try {
    const result = await runAction(action, interaction, client, botConfig);
    await done(result);
  } catch (err) {
    console.error(`[${botConfig.id}] /${interaction.commandName} ${action} failed:`, err);
    await done("Something went wrong running that command. Check the Railway logs for details.");
  }
}

async function runAction(
  action: string,
  interaction: ChatInputCommandInteraction<"cached">,
  client: Client<true>,
  botConfig: BotConfig
): Promise<string> {
  const botId = botConfig.id;
  const guildId = interaction.guildId;
  const here = interaction.channelId;
  const botName = interaction.guild.members.me?.displayName ?? client.user.displayName;
  const cmd = `/${interaction.commandName}`;
  const persistNote = isDbReady()
    ? ""
    : "\n-# Note: the database isn't connected, so this resets when the bot restarts.";

  switch (action) {
    // ---- quiet ----
    case "quiet":
      await updateSettings(botId, (s) => toggleInList(s.quietChannels, here, true));
      return `🤐 ${botName} will stay quiet in this channel. Use \`${cmd} unquiet\` to undo.${persistNote}`;
    case "unquiet":
      await updateSettings(botId, (s) => toggleInList(s.quietChannels, here, false));
      return `🗣️ ${botName} can talk in this channel again.${persistNote}`;

    // ---- blocklist ----
    case "block": {
      const user = interaction.options.getUser("user", true);
      if (user.id === client.user.id) return "She can't block herself 😅";
      await updateSettings(botId, (s) => toggleInList(s.blockedUsers, user.id, true));
      return `🚫 ${botName} will ignore ${userMention(user.id)}.${persistNote}`;
    }
    case "unblock": {
      const user = interaction.options.getUser("user", true);
      await updateSettings(botId, (s) => toggleInList(s.blockedUsers, user.id, false));
      return `✅ ${botName} will talk to ${userMention(user.id)} again.${persistNote}`;
    }
    case "blocklist": {
      const blocked = getSettings(botId).blockedUsers;
      return blocked.length
        ? `🚫 Ignored users:\n${blocked.map((id) => `• ${userMention(id)}`).join("\n")}`
        : "Nobody is blocked.";
    }

    // ---- status ----
    case "status": {
      const text = interaction.options.getString("text")?.trim() ?? "";
      const typeOption = interaction.options.getString("type") as StatusType | null;
      const status = typeOption ? { type: typeOption, text } : parseStatus(text);
      await updateSettings(botId, (s) => {
        s.status = status;
      });
      refreshPresence(client, botConfig, true);
      const sleeping = currentPhase(botId) !== "awake" && getSettings(botId).sleep.enabled;
      const sleepNoteText = sleeping ? `\n-# She's sleeping/just waking up right now, so it'll show once she's fully awake.` : "";
      return status.text
        ? `✨ Status set to **${describeStatus(status)}**${sleepNoteText}${persistNote}`
        : `Status cleared.${sleepNoteText}${persistNote}`;
    }

    // ---- chime-ins ----
    case "chimein on": {
      const s = await updateSettings(botId, (s) => toggleInList(s.chimeChannels, here, true));
      return (
        `💬 ${botName} may now randomly join conversations here ` +
        `(${s.chimeChance}% of messages, at most once every ${config.chimeCooldownMinutes} min).${persistNote}`
      );
    }
    case "chimein off":
      await updateSettings(botId, (s) => toggleInList(s.chimeChannels, here, false));
      return `${botName} won't randomly chime in here anymore (she still answers when called).${persistNote}`;
    case "chimein chance": {
      const percent = interaction.options.getNumber("percent", true);
      await updateSettings(botId, (s) => {
        s.chimeChance = percent;
      });
      return `🎲 Chime-in chance set to ${percent}% per message.${persistNote}`;
    }

    // ---- reactions ----
    case "reactions chance": {
      const percent = interaction.options.getNumber("percent", true);
      await updateSettings(botId, (s) => {
        s.reactionChance = percent;
      });
      return percent > 0
        ? `🎲 Reaction chance set to ${percent}%.${persistNote}`
        : `Reactions turned off.${persistNote}`;
    }
    case "reactions emojis": {
      const raw = interaction.options.getString("list", true).split(/\s+/).filter(Boolean);
      const valid = raw.filter((e) => EMOJI_PATTERN.test(e)).slice(0, 20);
      if (valid.length === 0) return "I couldn't find any emojis in that. Try something like: ❤️ 😂 👀";
      await updateSettings(botId, (s) => {
        s.reactionEmojis = valid;
      });
      const skipped = raw.length - valid.length;
      return `😊 She'll react with: ${valid.join(" ")}${skipped > 0 ? `\n(skipped ${skipped} that weren't emojis)` : ""}${persistNote}`;
    }

    // ---- welcome ----
    case "welcome on": {
      const channelId = interaction.options.getChannel("channel")?.id ?? here;
      await updateSettings(botId, (s) => {
        s.welcomeChannels[guildId] = channelId;
      });
      const hasIntent = new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildMembers);
      const warning = hasIntent
        ? ""
        : "\n⚠️ But Discord isn't telling her when people join yet: turn on **Server Members Intent** " +
          "in the Discord Developer Portal (Bot → Privileged Gateway Intents), then restart the bot on Railway.";
      return `👋 ${botName} will welcome new members in ${channelMention(channelId)}.${warning}${persistNote}`;
    }
    case "welcome off":
      await updateSettings(botId, (s) => {
        delete s.welcomeChannels[guildId];
      });
      return `Welcomes turned off.${persistNote}`;
    case "welcome test": {
      const channelId = getSettings(botId).welcomeChannels[guildId];
      if (!channelId) return `Set a welcome channel first with \`${cmd} welcome on\`.`;
      const posted = await welcomeMember(interaction.member, client, botConfig);
      return posted
        ? `Posted a test welcome in ${channelMention(channelId)}.`
        : `Couldn't post in ${channelMention(channelId)}. Check that she can see and send messages there.`;
    }

    // ---- schedules ----
    case "schedule add": {
      const time = parseTime(interaction.options.getString("time", true));
      if (!time) return "I didn't understand that time. Try something like `8am`, `8:30 pm` or `20:30`.";
      const prompt = interaction.options.getString("prompt", true).trim();
      const channelId = interaction.options.getChannel("channel")?.id ?? here;
      const days = (interaction.options.getString("days") as ScheduleDays | null) ?? "daily";

      if (getSettings(botId).schedules.length >= MAX_SCHEDULES) {
        return `There are already ${MAX_SCHEDULES} scheduled posts. Remove one first.`;
      }
      let id = 0;
      await updateSettings(botId, (s) => {
        id = s.nextScheduleId++;
        s.schedules.push({ id, guildId, channelId, time, days, prompt });
      });
      return (
        `⏰ Scheduled post **#${id}**: ${DAY_LABELS[days]} at **${formatTime(time)}** ` +
        `(${config.timezone}) in ${channelMention(channelId)}\n> ${prompt}\n` +
        `Use \`${cmd} schedule test id:${id}\` to try it now.${persistNote}`
      );
    }
    case "schedule list": {
      const posts = getSettings(botId).schedules.filter((p) => p.guildId === guildId);
      if (posts.length === 0) return `No scheduled posts yet. Add one with \`${cmd} schedule add\`.`;
      const lines = posts.map(
        (p) =>
          `**#${p.id}** · ${DAY_LABELS[p.days]} at ${formatTime(p.time)} in ${channelMention(p.channelId)}\n> ${p.prompt}`
      );
      return `⏰ Scheduled posts (times in ${config.timezone}):\n${lines.join("\n")}`;
    }
    case "schedule remove": {
      const id = interaction.options.getInteger("id", true);
      let removed = false;
      await updateSettings(botId, (s) => {
        const before = s.schedules.length;
        s.schedules = s.schedules.filter((p) => !(p.id === id && p.guildId === guildId));
        removed = s.schedules.length < before;
      });
      return removed ? `🗑️ Removed scheduled post #${id}.` : `There's no scheduled post #${id}.`;
    }
    case "schedule test": {
      const id = interaction.options.getInteger("id", true);
      const post = getSettings(botId).schedules.find((p) => p.id === id && p.guildId === guildId);
      if (!post) return `There's no scheduled post #${id}.`;
      await runScheduledPost(client, botConfig, post);
      return `Posted scheduled message #${id} in ${channelMention(post.channelId)}.`;
    }

    // ---- memories (owner only) ----
    case "memory add":
    case "memory nicknames":
    case "memory list":
    case "memory remove":
      if (!isOwner(botId, interaction.user.id)) {
        return "🔒 Only the bot owner can manage her memories.";
      }
      return memoryAction(action, interaction, botId, botName);

    // ---- reply length ----
    case "length": {
      const size = interaction.options.getString("size", true) as ReplyLength;
      await updateSettings(botId, (s) => {
        s.replyLength = size;
      });
      const labels: Record<ReplyLength, string> = {
        short: "short (1-3 sentences)",
        medium: "medium (a short paragraph)",
        long: "long (a few paragraphs)",
        off: "no limit",
      };
      return `📏 Replies are now **${labels[size]}**.${persistNote}`;
    }

    // ---- sleep schedule ----
    case "sleep on":
    case "sleep off": {
      const enabled = action === "sleep on";
      const s = await updateSettings(botId, (s) => {
        s.sleep.enabled = enabled;
      });
      refreshPresence(client, botConfig, true);
      return enabled
        ? `😴 Sleep schedule on: asleep ${formatTime(s.sleep.bedtime)}–${formatTime(s.sleep.wake)} (${config.timezone}).${persistNote}`
        : `☀️ Sleep schedule off — she's always awake now.${persistNote}`;
    }
    case "sleep set": {
      const bedtime = parseTime(interaction.options.getString("bedtime", true));
      const wake = parseTime(interaction.options.getString("wake", true));
      if (!bedtime || !wake) return "I didn't understand those times. Try something like `11pm` and `7am`.";
      if (bedtime === wake) return "Bedtime and wake-up time can't be the same.";
      await updateSettings(botId, (s) => {
        s.sleep = { enabled: true, bedtime, wake };
      });
      refreshPresence(client, botConfig, true);
      return `😴 She'll sleep from **${formatTime(bedtime)}** to **${formatTime(wake)}** (${config.timezone}).${persistNote}`;
    }

    // ---- birthdays ----
    case "birthdays on": {
      const channelId = interaction.options.getChannel("channel")?.id ?? here;
      await updateSettings(botId, (s) => {
        s.birthdayChannels[guildId] = channelId;
      });
      return (
        `🎂 Birthday wishes will be posted in ${channelMention(channelId)} at ${formatTime(config.birthdayTime)}. ` +
        `People can tell her with *${botName}, my birthday is May 5*.${persistNote}`
      );
    }
    case "birthdays off":
      await updateSettings(botId, (s) => {
        delete s.birthdayChannels[guildId];
      });
      return `Birthday wishes won't be posted here anymore (she'll DM people instead).${persistNote}`;
    case "birthdays list": {
      const list = await allBirthdays(botId);
      if (list.length === 0) return `No birthdays saved yet. People can say *${botName}, my birthday is May 5*.`;
      const ids = list.map((b) => b.userId);
      const members = await interaction.guild.members.fetch({ user: ids }).catch(() => null);
      const inServer = members ? list.filter((b) => members.has(b.userId)) : list;
      if (inServer.length === 0) return "Nobody in this server has saved a birthday yet.";
      return `🎂 **Birthdays**\n${inServer.map((b) => `• ${MONTHS[b.month - 1]} ${b.day} — ${userMention(b.userId)}`).join("\n")}`;
    }

    // ---- info ----
    case "settings":
      return describeSettings(botConfig, guildId, cmd);
    case "stats":
      return stats(botId, interaction.guild, botName);

    default:
      return "Unknown command.";
  }
}

function describeSettings(botConfig: BotConfig, guildId: string, cmd: string): string {
  const s = getSettings(botConfig.id);
  const list = (ids: string[], fmt: (id: string) => string) =>
    ids.length ? ids.map(fmt).join(", ") : "none";
  const status = s.status ?? parseStatus(botConfig.defaultStatus);
  const welcome = s.welcomeChannels[guildId];
  const scheduleCount = s.schedules.filter((p) => p.guildId === guildId).length;

  return [
    `**Settings** (change them with \`${cmd}\`)`,
    `• Status: ${describeStatus(status)}`,
    `• Quiet channels: ${list(s.quietChannels, channelMention)}`,
    `• Blocked users: ${s.blockedUsers.length}`,
    `• Chime-in channels: ${list(s.chimeChannels, channelMention)} · chance ${s.chimeChance}%`,
    `• Reactions: ${s.reactionChance}% · ${s.reactionEmojis.join(" ") || "no emojis"}`,
    `• Welcome channel: ${welcome ? channelMention(welcome) : "off"}`,
    `• Scheduled posts: ${scheduleCount}`,
    `• Reply length: ${s.replyLength}`,
    `• Sleep schedule: ${s.sleep.enabled ? `${formatTime(s.sleep.bedtime)}–${formatTime(s.sleep.wake)}` : "off"}`,
    `• Birthday channel: ${s.birthdayChannels[guildId] ? channelMention(s.birthdayChannels[guildId]) : "none (DMs)"}`,
    `• Saved to database: ${isDbReady() ? "yes" : "no (settings reset on restart)"}`,
  ].join("\n");
}

async function memoryAction(
  action: string,
  interaction: ChatInputCommandInteraction<"cached">,
  botId: string,
  botName: string
): Promise<string> {
  const settings = getSettings(botId);
  const nameOf = async (userId: string, fallback: string) =>
    (await interaction.guild.members.fetch(userId).catch(() => null))?.displayName ?? fallback;
  const persistNote = isDbReady() ? "" : "\n-# Note: the database isn't connected, so this resets when the bot restarts.";

  if (action === "memory add") {
    if (settings.memories.length >= MAX_MEMORIES) return `She already remembers ${MAX_MEMORIES} things. Remove some first.`;
    const fact = interaction.options.getString("fact", true).trim().slice(0, MAX_FACT_LENGTH);
    const user = interaction.options.getUser("person");
    const userName = user ? await nameOf(user.id, user.displayName) : null;
    let id = 0;
    await updateSettings(botId, (s) => {
      id = s.nextMemoryId++;
      s.memories.push({ id, userId: user?.id ?? null, userName, fact });
    });
    return `🧠 Memory **#${id}** saved${user ? ` about ${userMention(user.id)}` : ""}:\n> ${fact}\n${botName} will treat this as true.${persistNote}`;
  }

  if (action === "memory nicknames") {
    const user = interaction.options.getUser("person", true);
    const names = (interaction.options.getString("names") ?? "")
      .split(",")
      .map((n) => n.trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 10);
    const displayName = await nameOf(user.id, user.displayName);
    await updateSettings(botId, (s) => {
      if (names.length) s.nicknames[user.id] = names;
      else delete s.nicknames[user.id];
      // Remember their current name too, so she recognizes it in chat.
      for (const m of s.memories) if (m.userId === user.id) m.userName = displayName;
      if (!s.memories.some((m) => m.userId === user.id) && names.length && !names.includes(displayName)) {
        s.nicknames[user.id] = [displayName, ...names].slice(0, 10);
      }
    });
    return names.length
      ? `🏷️ ${botName} now knows ${userMention(user.id)} also goes by: **${names.join(", ")}**${persistNote}`
      : `Nicknames cleared for ${userMention(user.id)}.${persistNote}`;
  }

  if (action === "memory list") {
    const user = interaction.options.getUser("person");
    const facts = settings.memories.filter((m) => !user || m.userId === user.id);
    const nicknameLines = Object.entries(settings.nicknames)
      .filter(([id]) => !user || id === user.id)
      .map(([id, names]) => `🏷️ ${userMention(id)} also goes by: ${names.join(", ")}`);
    if (facts.length === 0 && nicknameLines.length === 0) {
      return user ? `She doesn't remember anything about ${userMention(user.id)} yet.` : "She doesn't remember anything yet. Add something with `memory add`.";
    }
    const factLines = facts.map((m) => `**#${m.id}** ${m.userId ? userMention(m.userId) : "🌐 general"} — ${m.fact}`);
    return [`🧠 **What ${botName} remembers**`, ...factLines, ...nicknameLines].join("\n");
  }

  // memory remove
  const id = interaction.options.getInteger("id", true);
  let removed = false;
  await updateSettings(botId, (s) => {
    const before = s.memories.length;
    s.memories = s.memories.filter((m) => m.id !== id);
    removed = s.memories.length < before;
  });
  return removed ? `🗑️ ${botName} forgot memory #${id}.` : `There's no memory #${id}.`;
}

async function favorites(botId: string, guild: Guild): Promise<string> {
  const top = await topAffection(botId, 50);
  if (top.length === 0) return "";
  const members = await guild.members.fetch({ user: top.map((t) => t.userId) }).catch(() => null);
  const inServer = (members ? top.filter((t) => members.has(t.userId)) : top).slice(0, 10);
  if (inServer.length === 0) return "";
  return inServer
    .map((t, i) => {
      const level = levelFor(t.points);
      return `${i + 1}. ${level.emoji} **${t.userName}** — ${level.name}${t.triviaWins ? ` · 🧠 ${t.triviaWins}` : ""}`;
    })
    .join("\n");
}

async function stats(botId: string, guild: Guild, botName: string): Promise<string> {
  const favoriteList = await favorites(botId, guild);
  const favoriteSection = favoriteList ? ["", "💕 **Her favorites:**", favoriteList] : [];

  if (!pool || !isDbReady()) {
    return [
      `📊 **${botName}'s stats**`,
      "Message counts need the database. Connect Postgres on Railway (set DATABASE_URL) and they'll start counting.",
      ...favoriteSection,
    ].join("\n");
  }

  const totals = await pool.query<{ messages: number; replies: number; people: number }>(
    `SELECT COUNT(*) FILTER (WHERE direction = 'incoming')::int AS messages,
            COUNT(*) FILTER (WHERE direction = 'outgoing')::int AS replies,
            COUNT(DISTINCT user_id) FILTER (WHERE direction = 'incoming')::int AS people
       FROM chat_logs
      WHERE bot_id = $1 AND guild_id = $2 AND created_at > now() - interval '30 days'`,
    [botId, guild.id]
  );
  const top = await pool.query<{ user_name: string; count: number }>(
    `SELECT MAX(user_name) AS user_name, COUNT(*)::int AS count
       FROM chat_logs
      WHERE bot_id = $1 AND guild_id = $2 AND direction = 'incoming'
        AND created_at > now() - interval '30 days'
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10`,
    [botId, guild.id]
  );

  const t = totals.rows[0] ?? { messages: 0, replies: 0, people: 0 };
  if (t.messages === 0) {
    return [`No chats with ${botName} in this server in the last 30 days yet.`, ...favoriteSection].join("\n");
  }

  const medals = ["🥇", "🥈", "🥉"];
  const leaderboard = top.rows
    .map((row, i) => `${medals[i] ?? `${i + 1}.`} **${row.user_name}** — ${row.count} message${row.count === 1 ? "" : "s"}`)
    .join("\n");

  return [
    `📊 **${botName}'s stats** (last 30 days, this server)`,
    `${t.messages} messages from ${t.people} people · ${t.replies} replies`,
    "",
    "**Who talks to her the most:**",
    leaderboard,
    ...favoriteSection,
  ].join("\n");
}
