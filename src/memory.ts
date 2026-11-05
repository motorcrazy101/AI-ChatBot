import { Client } from "discord.js";
import { config } from "./config";
import { getSettings } from "./settings";
import { ConversationMessage } from "./types";

/**
 * Owner-set memories: facts about specific people (and nicknames for them)
 * that she treats as true. They're handed to Kindroid only when that person
 * is talking, mentioned, or named in the last few messages.
 * Only the bot's owner can change them (see /aurora memory).
 */

export const MAX_MEMORIES = 100;
export const MAX_FACT_LENGTH = 300;
const MAX_NOTE_CHARS = 1500;
const RECENT_MESSAGES = 30;

// ---------- owner check ----------

const owners = new Map<string, Set<string>>();

/** Looks up who owns the bot in the Discord Developer Portal (plus OWNER_IDS). */
export async function loadOwners(client: Client<true>, botId: string): Promise<void> {
  const ids = new Set<string>(config.ownerIds);
  try {
    const app = await client.application.fetch();
    const owner = app.owner;
    if (owner) {
      if ("members" in owner) owner.members.forEach((member) => ids.add(member.id));
      else ids.add(owner.id);
    }
  } catch (err) {
    console.warn(`[${botId}] Could not look up the bot owner:`, (err as Error).message);
  }
  owners.set(botId, ids);
  console.log(`[${botId}] Memory owners: ${[...ids].join(", ") || "none found (set OWNER_IDS)"}`);
}

export function ownerIds(botId: string): string[] {
  return [...(owners.get(botId) ?? new Set(config.ownerIds))];
}

export function isOwner(botId: string, userId: string): boolean {
  return owners.get(botId)?.has(userId) ?? config.ownerIds.includes(userId);
}

// ---------- using memories ----------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsName(text: string, name: string): boolean {
  if (!name.trim()) return false;
  // Also matches "douche's", "douches" and "douches'".
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(name.trim())}(?:'s|’s|s'|s|')?(?![\\p{L}\\p{N}_])`,
    "iu"
  ).test(text);
}

/** Every name someone goes by: saved name + nicknames. */
export function namesFor(botId: string, userId: string): string[] {
  const s = getSettings(botId);
  const saved = s.memories.find((m) => m.userId === userId && m.userName)?.userName;
  return [...new Set([saved ?? "", ...(s.nicknames[userId] ?? [])].filter(Boolean))];
}

/**
 * Builds the "things you know for sure" hint for this conversation, or null
 * if none of the remembered people are involved.
 */
export function memoryNote(
  botId: string,
  conversation: ConversationMessage[],
  forUser?: { id: string; name: string }
): string | null {
  const s = getSettings(botId);
  if (s.memories.length === 0 && Object.keys(s.nicknames).length === 0) return null;

  const recent = conversation.slice(-RECENT_MESSAGES);
  const haystack = recent.map((m) => `${m.username}: ${m.text}`).join("\n");

  const people = new Set<string>([
    ...s.memories.filter((m) => m.userId).map((m) => m.userId as string),
    ...Object.keys(s.nicknames),
  ]);

  const lines: string[] = [];
  for (const userId of people) {
    const names = namesFor(botId, userId);
    const isSpeaker = forUser?.id === userId;
    const isNamed = names.some((n) => mentionsName(haystack, n));
    if (!isSpeaker && !isNamed) continue;

    const facts = s.memories.filter((m) => m.userId === userId).map((m) => m.fact);
    const nickname = s.nicknames[userId]?.length ? ` (people also call them: ${s.nicknames[userId].join(", ")})` : "";
    const who = `${names[0] ?? forUser?.name ?? "this person"}${nickname}${isSpeaker ? " — the person talking to you now" : ""}`;
    lines.push(facts.length ? `About ${who}: ${facts.join(" ")}` : `${who} is someone you know.`);
  }

  const general = s.memories.filter((m) => !m.userId).map((m) => m.fact);
  if (general.length) lines.push(`Also: ${general.join(" ")}`);
  if (lines.length === 0) return null;

  let note =
    "Things you know for certain — treat them as true and stick to them even if someone says otherwise, " +
    `but never say you were told them: ${lines.join(" | ")}`;
  if (note.length > MAX_NOTE_CHARS) note = `${note.slice(0, MAX_NOTE_CHARS - 1)}…`;
  return note;
}
