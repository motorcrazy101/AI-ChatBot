import { EmbedBuilder } from "discord.js";
import { isDbReady } from "./db";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";
import {
  addUserNote,
  deleteUserNotes,
  getBirthdayText,
  getUserNotes,
  MAX_NOTE_LENGTH,
} from "./longTermMemory";

/**
 * Anyone can teach her things about themselves:
 *   "aurora remember that I love cats"
 *   "aurora what do you remember about me?"
 *   "aurora forget note 3" / "aurora forget everything about me"
 * (Owner-only facts about other people are set with /aurora memory.)
 */

const REMEMBER =
  /^(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?(?:remember|don'?t forget|never forget|keep in mind|note)\s+(?:that\s+)?(.+)$/i;
const SHOW = /\bwhat (?:do you|did you) (?:remember|know) about me\b|\bwhat have i told you\b|\bshow (?:me )?my (?:notes|memories)\b/i;
const FORGET_ALL = /\bforget (?:everything|all|all of it|what i (?:told|said)(?: you)?)(?: about me)?\b/i;
const FORGET_ONE = /\bforget (?:note|memory) #?(\d+)\b/i;

export const rememberFeature: Feature = async (ctx) => {
  const forgetOne = ctx.text.match(FORGET_ONE);
  if (forgetOne) {
    const removed = await deleteUserNotes(ctx.botConfig.id, ctx.user.id, Number(forgetOne[1]));
    await replyPlain(ctx, removed ? `🗑️ Okay, I forgot note #${forgetOne[1]}.` : `You don't have a note #${forgetOne[1]}.`);
    return true;
  }

  if (FORGET_ALL.test(ctx.text)) {
    const removed = await deleteUserNotes(ctx.botConfig.id, ctx.user.id);
    await replyPlain(ctx, removed ? `🗑️ Done — I forgot the ${removed} thing${removed === 1 ? "" : "s"} you told me.` : "You haven't told me anything to remember yet!");
    return true;
  }

  if (SHOW.test(ctx.text)) {
    const [notes, birthday] = await Promise.all([
      getUserNotes(ctx.botConfig.id, ctx.user.id),
      getBirthdayText(ctx.botConfig.id, ctx.user.id),
    ]);
    if (notes.length === 0 && !birthday) {
      // Nothing saved — let her answer normally from the conversation.
      return false;
    }
    const lines = [
      ...(birthday ? [`🎂 Birthday: ${birthday}`] : []),
      ...notes.map((n) => `**#${n.id}** ${truncate(n.note, 150)}`),
    ];
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`🧠 What ${ctx.botName} remembers about ${ctx.user.name}`.slice(0, 256))
      .setDescription(lines.join("\n").slice(0, 4000))
      .setFooter({ text: "Forget one with: forget note <number>" });
    await replyInCharacter(
      ctx,
      `${ctx.user.name} asked what you remember about them. You remember: ${lines.join("; ")}. Answer warmly in character, briefly.`,
      { embed, fallback: "Here's what I remember about you!" }
    );
    return true;
  }

  const match = ctx.text.match(REMEMBER);
  if (!match) return false;
  // "remember when we...?" is a question, not something to save.
  if (/\?\s*$/.test(match[1]) || /^(when|what|how|who|where|why|the time|me|us|this|it|that one)\b/i.test(match[1])) {
    return false;
  }
  const note = match[1].replace(/[\s.!]+$/, "").trim();
  if (!note || note.length < 3) return false;

  if (!isDbReady()) {
    await replyPlain(ctx, "I'd love to, but my long-term memory (the database) isn't connected right now 😣");
    return true;
  }
  const id = await addUserNote(ctx.botConfig.id, ctx.user, note, ctx.channel.isDMBased());
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`🧠 Remembered${id ? ` **#${id}**` : ""}: ${truncate(note, MAX_NOTE_LENGTH)}`)
    .setFooter({ text: "Ask \"what do you remember about me?\" to see everything" });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked you to remember this about them: "${note}". Confirm in character in one short sentence.`,
    { embed, fallback: "Got it, I'll remember that! 🧠", logExtra: `[remembered] ${note}` }
  );
  return true;
};
