import { EmbedBuilder } from "discord.js";
import { getAffection, getStreak, progressBar } from "./affection";
import { CLASSES } from "./asylum";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain } from "./featureKit";
import { getCharacter } from "./gameState";
import { getBirthdayText } from "./longTermMemory";
import { ReplyChannel } from "./respond";
import {
  ACHIEVEMENTS,
  achievementByKey,
  award,
  getAchievements,
  getOrAssignRoom,
  getStats,
  topStat,
} from "./residentsData";

/**
 * Resident life: rooms, profiles, badges and the curfew leaderboard.
 *   "aurora my profile" · "aurora profile @Lilly"
 *   "aurora my room" · "aurora achievements" (all badges) · "aurora my badges"
 *   "aurora curfew leaderboard"
 */

const PROFILE = /\bmy\s+(?:profile|resident\s+(?:file|card))\b|^(?:show\s+)?(?:the\s+)?profile\b|\bprofile\s+(?:for|of)\b|\bresident\s+(?:file|card)\s+(?:for|of)\b/i;
const ROOM = /\b(?:what'?s|whats|show|where'?s|wheres|which\s+is|tell\s+me)\s+(?:me\s+)?(?:my|\S+'s)\s+(?:room|ward)\b|^(?:my\s+)?(?:room|ward)(?:\s+number)?[?!.]*$|^my\s+room\b|\b(?:which|what)\s+(?:room|ward)\s+(?:am\s+i|do\s+i|is|does)\b|\broom\s+(?:number|assignment)s?\b/i;
const MY_BADGES = /\bmy\s+(?:achievements|badges)\b/i;
const ALL_BADGES = /^(?:list\s+|show\s+|all\s+)?(?:the\s+)?(?:achievements|badges)(?:\s+list)?[?!.]*$|\bwhat\s+(?:achievements|badges)\b/i;
const CURFEW_BOARD = /\b(?:curfew|night\s*patrol|caught)\s+(?:leaderboard|board|ranking|rankings|top)\b|\bmost\s+caught\b/i;

/** First talk with her: assign a room and give the 🏥 New Resident badge. */
export async function welcomeResident(botId: string, user: { id: string; name: string }, channel: ReplyChannel): Promise<void> {
  if (channel.isDMBased()) return;
  await getOrAssignRoom(botId, user.id);
  await award(botId, user, "resident", channel); // only announced the first time

}

/** "Room 214, East Wing" for longTermNote-style hints. */
export async function roomNote(botId: string, user: { id: string; name: string }): Promise<string> {
  const room = await getOrAssignRoom(botId, user.id);
  return `${user.name} lives in Room ${room.room} of the ${room.ward} in the Asylum.`;
}

function targetOf(ctx: Parameters<Feature>[0]): { id: string; name: string } {
  const mentioned = ctx.message.mentions.users.find((u) => u.id !== ctx.client.user.id);
  if (!mentioned) return ctx.user;
  const member = ctx.message.guild?.members.cache.get(mentioned.id);
  return { id: mentioned.id, name: member?.displayName ?? mentioned.displayName };
}

async function profileEmbed(botId: string, who: { id: string; name: string }, avatar: string | null): Promise<EmbedBuilder> {
  const [room, affection, streak, birthday, character, stats, badges] = await Promise.all([
    getOrAssignRoom(botId, who.id),
    getAffection(botId, who),
    getStreak(botId, who),
    getBirthdayText(botId, who.id).catch(() => null),
    getCharacter(botId, who.id).catch(() => null),
    getStats(botId, who.id),
    getAchievements(botId, who.id),
  ]);
  const cls = character ? CLASSES.find((c) => c.key === character.classKey) : null;
  const badgeText = badges
    .map((k) => achievementByKey(k))
    .filter(Boolean)
    .map((a) => `${a!.emoji} ${a!.name}`)
    .join(" · ");

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`🏥 Resident File: ${who.name}`)
    .setDescription(`**Room ${room.room}** · ${room.ward}`)
    .addFields(
      { name: `${affection.level.emoji} ${affection.level.name}`, value: progressBar(affection.points), inline: false },
      { name: "🔥 Streak", value: `${streak.streak} day${streak.streak === 1 ? "" : "s"} (best ${streak.best})`, inline: true },
      { name: "🎂 Birthday", value: birthday ?? "not on file", inline: true },
      {
        name: "🎭 Character",
        value: character ? `${cls?.emoji ?? ""} ${character.name} the ${cls?.name ?? character.classKey}` : "none yet",
        inline: true,
      },
      {
        name: "📊 Record",
        value:
          `🧠 Trivia wins: **${affection.triviaWins}** · 🏃 Escapes: **${stats.escaped ?? 0}** · ` +
          `🕵️ Cases solved: **${stats.detective ?? 0}** · 📁 Files cracked: **${stats.secretfile ?? 0}**\n` +
          `🎁 Gifts given: **${stats.gifts ?? 0}** · 🚨 Caught after curfew: **${stats.curfew ?? 0}**`,
      },
      { name: `🏅 Badges (${badges.length}/${ACHIEVEMENTS.length})`, value: badgeText || "none yet — keep hanging around!" }
    );
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

export const residentFeature: Feature = async (ctx) => {
  const botId = ctx.botConfig.id;

  if (CURFEW_BOARD.test(ctx.text)) {
    const top = await topStat(botId, "curfew", 10);
    const guild = ctx.message.guild;
    const lines = top.map(
      (t, i) =>
        `${["🥇", "🥈", "🥉"][i] ?? `**${i + 1}.**`} ${guild?.members.cache.get(t.userId)?.displayName ?? `<@${t.userId}>`} — ${t.value} catch${t.value === 1 ? "" : "es"}`
    );
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🚨 Most Caught After Curfew")
      .setDescription(lines.join("\n") || "Nobody's been caught yet… suspicious. 👀")
      .setFooter({ text: "The Warden's night patrol runs from lights-out until morning" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (MY_BADGES.test(ctx.text)) {
    const who = targetOf(ctx);
    const badges = new Set(await getAchievements(botId, who.id));
    const embed = new EmbedBuilder()
      .setColor(0xffb020)
      .setTitle(`🏅 ${who.name}'s badges (${badges.size}/${ACHIEVEMENTS.length})`)
      .setDescription(ACHIEVEMENTS.map((a) => (badges.has(a.key) ? `${a.emoji} **${a.name}** — ${a.how}` : `🔒 ~~${a.name}~~ — ${a.how}`)).join("\n"));
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (ALL_BADGES.test(ctx.text)) {
    const embed = new EmbedBuilder()
      .setColor(0xffb020)
      .setTitle("🏅 Asylum Achievements")
      .setDescription(ACHIEVEMENTS.map((a) => `${a.emoji} **${a.name}** — ${a.how}`).join("\n"))
      .setFooter({ text: "See yours: my badges" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (PROFILE.test(ctx.text)) {
    const who = targetOf(ctx);
    const target = who.id === ctx.user.id ? ctx.message.author : ctx.message.mentions.users.get(who.id);
    const embed = await profileEmbed(botId, who, target?.displayAvatarURL() ?? null);
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (ROOM.test(ctx.text)) {
    const who = targetOf(ctx);
    const room = await getOrAssignRoom(botId, who.id);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription(`🚪 **${who.name}** — Room **${room.room}**, ${room.ward}`);
    await replyInCharacter(
      ctx,
      `${ctx.user.name} asked which room ${who.id === ctx.user.id ? "they live in" : `${who.name} lives in`} at the Asylum. ` +
        `It's Room ${room.room} in the ${room.ward}. Tell them in one playful sentence (maybe a tiny rumor about that ward).`,
      { embed, fallback: `Room ${room.room}, ${room.ward}! 🗝️`, logExtra: `[room] ${room.room} ${room.ward}` }
    );
    return true;
  }

  return false;
};
