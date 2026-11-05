import { Guild } from "discord.js";
import { ownerIds, namesFor } from "./memory";
import { getSettings } from "./settings";

/**
 * The Anime Asylum: the shared world for every story game (adventures,
 * mysteries, the logbook, roleplay scenes). Playful, never mocking real
 * mental illness. The bot owner is the one and only Warden.
 */

// ---------- the Warden ----------

export interface Warden {
  id: string | null;
  name: string;
  nicknames: string[];
}

/** The bot's owner, as the Warden (name from the server, nicknames from /aurora memory). */
export function wardenFor(botId: string, guild: Guild | null): Warden {
  const id = ownerIds(botId)[0] ?? null;
  if (!id) return { id: null, name: "the Warden", nicknames: [] };
  const member = guild?.members.cache.get(id);
  const saved = namesFor(botId, id);
  const nicknames = getSettings(botId).nicknames[id] ?? [];
  const name = member?.displayName ?? saved[0] ?? "the Warden";
  return { id, name, nicknames };
}

export function wardenDescription(w: Warden): string {
  const aka = w.nicknames.length ? ` (people also call him ${w.nicknames.join(", ")})` : "";
  return (
    `The Warden is ${w.name}${aka}, the real owner of this server and the ONLY Warden — never make anyone else ` +
    "the Warden. He runs the Asylum: he patrols, catches rule-breakers, hands out timeouts and keeps order. " +
    "He's stern but fair; the residents respect him (and fear getting caught). He can appear in stories, " +
    "but never gets hurt or humiliated."
  );
}

// ---------- the world ----------

export const WORLD =
  "Setting: the Anime Asylum — a big, eccentric old building where anime-obsessed residents live under the " +
  "Warden's rules: lights-out at 11, no running in the halls, no contraband snacks. Places: the cafeteria, the rec room " +
  "with the ancient TV, the library of forbidden manga, the rooftop, the laundry room, the locked East Wing, the " +
  "Warden's office. Staff: Nurse Mochi (sweet but sees everything), Tanuki the groundskeeper (grumpy, loves his " +
  "garden), Auntie Udon who runs the cafeteria. Keep it playful — pranks, mysteries, friendships, spooky rumors — " +
  "and never mock real mental illness. Aurora is a resident herself.";

export const LOCATIONS = [
  "the cafeteria", "the rec room", "the library of forbidden manga", "the rooftop", "the laundry room",
  "the East Wing hallway", "the Warden's office", "the courtyard garden", "the nurse's station", "the basement",
];

// ---------- story packs ----------

export type Tone = "comedic" | "spooky" | "mixed";

export interface StoryPack {
  key: string;
  name: string;
  emoji: string;
  tone: Tone;
  premise: string;
  goal: string;
  items: string[];
}

export const PACKS: StoryPack[] = [
  {
    key: "escape",
    name: "Escape the Asylum",
    emoji: "🏃",
    tone: "mixed",
    premise: "Tonight's the night: the residents plan to sneak out past the night staff for the anime convention across town.",
    goal: "Get outside the front gate before the Warden's morning rounds.",
    items: ["a stolen keycard", "a bedsheet rope", "Nurse Mochi's spare lanyard", "a map drawn on a napkin", "a flashlight"],
  },
  {
    key: "nightshift",
    name: "The Night Shift",
    emoji: "🌙",
    tone: "comedic",
    premise: "After lights-out, the residents secretly take over the halls for a legendary midnight snack raid.",
    goal: "Raid Auntie Udon's secret snack stash and get back to bed without getting caught.",
    items: ["a pudding cup", "a pocky stash", "fuzzy socks (for silent walking)", "a walkie-talkie", "the rec room remote"],
  },
  {
    key: "isekai",
    name: "The Isekai Ward",
    emoji: "✨",
    tone: "mixed",
    premise: "A new resident insists they were summoned from another world — and strange glowing doors keep appearing in the halls.",
    goal: "Find out the truth about the new resident and close the glowing door before it swallows the Asylum.",
    items: ["a glowing crystal", "a 'legendary' broom sword", "a spellbook (actually a manga)", "a mysterious amulet", "a party hat crown"],
  },
  {
    key: "eastwing",
    name: "The Haunted East Wing",
    emoji: "👻",
    tone: "spooky",
    premise: "Everyone whispers about the locked East Wing. Tonight the door was found open… and someone is humming inside.",
    goal: "Discover what's really hiding in the East Wing and make it back before dawn.",
    items: ["a flickering flashlight", "an old brass key", "a dusty diary", "salt from the cafeteria", "a candle stub"],
  },
  {
    key: "lockdown",
    name: "Lockdown",
    emoji: "🔒",
    tone: "spooky",
    premise: "The alarms blare and every door seals shut. The lights are failing, and something in the basement is awake.",
    goal: "Work together to restore the power and reach the Warden's office safely.",
    items: ["a fuse", "a wrench", "the Warden's whistle", "a glow stick", "an emergency radio"],
  },
  {
    key: "cosplay",
    name: "The Great Cosplay Riot",
    emoji: "🎭",
    tone: "comedic",
    premise: "Someone stole the Warden's prized figure collection, and the Asylum's cosplay contest has descended into chaos.",
    goal: "Find the figures and return them to the Warden before he notices — or face the timeout of the century.",
    items: ["a wig", "a cardboard sword", "a sewing kit", "a fake mustache", "a glitter bomb"],
  },
];

export function findPack(text: string): StoryPack | null {
  const t = text.toLowerCase();
  return (
    PACKS.find((p) => t.includes(p.key)) ??
    PACKS.find((p) => t.includes(p.name.toLowerCase().replace(/^the /, ""))) ??
    PACKS.find((p) => p.name.toLowerCase().split(" ").filter((w) => w.length > 4).some((w) => t.includes(w))) ??
    null
  );
}

export const TONE_GUIDE: Record<Tone, string> = {
  comedic: "Tone: silly, chaotic and funny — slapstick, near-misses, absurd situations.",
  spooky: "Tone: spooky and suspenseful — creaking doors, whispers, flickering lights — but never gory.",
  mixed: "Tone: a mix of funny and spooky — tense moments broken up by comedy.",
};

// ---------- resident classes ----------

export interface ResidentClass {
  key: string;
  name: string;
  emoji: string;
  perk: string;
  /** Words in an option that this class is good at (+3 to the roll). */
  skills: string[];
}

export const CLASSES: ResidentClass[] = [
  { key: "escape", name: "Escape Artist", emoji: "🗝️", perk: "sneaking, lockpicking and getting out of tight spots", skills: ["sneak", "lock", "pick", "escape", "hide", "climb", "slip", "quiet"] },
  { key: "medic", name: "Medic", emoji: "🩹", perk: "patching people up (in a 'borrowed' nurse uniform)", skills: ["help", "heal", "nurse", "bandage", "calm", "rest", "patch", "care"] },
  { key: "scholar", name: "Weeb Scholar", emoji: "📚", perk: "knowing every anime trope and reading clues", skills: ["read", "study", "research", "book", "clue", "trope", "remember", "decode", "library"] },
  { key: "cosplayer", name: "Cosplayer", emoji: "🎭", perk: "disguises, acting and talking your way past people", skills: ["disguise", "pretend", "costume", "act", "bluff", "talk", "convince", "distract"] },
  { key: "nightowl", name: "Night Owl", emoji: "🦉", perk: "seeing in the dark and noticing what others miss", skills: ["look", "search", "watch", "spot", "listen", "dark", "investigate", "check", "explore"] },
];

export function findClass(text: string): ResidentClass | null {
  const t = text.toLowerCase();
  return (
    CLASSES.find((c) => t.includes(c.name.toLowerCase())) ??
    CLASSES.find((c) => t.includes(c.key)) ??
    CLASSES.find((c) => t.includes(c.name.toLowerCase().split(" ").pop() ?? "~")) ??
    null
  );
}

// ---------- mystery cast ----------

export interface Suspect {
  name: string;
  emoji: string;
  personality: string;
}

export const SUSPECTS: Suspect[] = [
  { name: "Mimi", emoji: "🎀", personality: "a dramatic cosplayer who changes outfits five times a day" },
  { name: "Kaito", emoji: "🎮", personality: "a sleep-deprived gamer who hasn't left the rec room in weeks" },
  { name: "Nurse Mochi", emoji: "🩺", personality: "the sweet nurse who sees everything and gossips a little too much" },
  { name: "Tanuki", emoji: "🌿", personality: "the grumpy groundskeeper who guards his garden like a dragon" },
  { name: "Yuki", emoji: "🌙", personality: "a quiet night owl who writes everything in a notebook" },
  { name: "Professor Bento", emoji: "🍱", personality: "a self-proclaimed anime scholar who lectures anyone who'll listen" },
  { name: "Auntie Udon", emoji: "🍜", personality: "the cafeteria boss with a secret soft spot for gossip" },
  { name: "Ren", emoji: "🎸", personality: "a moody wannabe rockstar who practices air guitar at 3am" },
];

export interface MysteryCase {
  title: string;
  crime: string;
  /** Where clues can be found. */
  places: string[];
}

export const CASES: MysteryCase[] = [
  { title: "The Case of the Missing Keys", crime: "the Warden's master keys vanished from his office", places: ["the Warden's office", "the laundry room", "the courtyard garden", "the rec room"] },
  { title: "The Great Pudding Heist", crime: "every pudding cup in the cafeteria disappeared overnight", places: ["the cafeteria", "the rooftop", "the library of forbidden manga", "the basement"] },
  { title: "The Stolen Figure Collection", crime: "the Warden's limited-edition figure collection went missing", places: ["the Warden's office", "the East Wing hallway", "the rec room", "the laundry room"] },
  { title: "The Midnight TV Mystery", crime: "someone changed the rec room TV's password and locked everyone out of anime night", places: ["the rec room", "the nurse's station", "the rooftop", "the basement"] },
  { title: "The Flooded Bathroom", crime: "the second-floor bathroom was flooded with bubble bath right before inspection", places: ["the laundry room", "the nurse's station", "the cafeteria", "the courtyard garden"] },
];

// ---------- dice ----------

export function rollD20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

export type RollResult = "critical fail" | "fail" | "mixed" | "success" | "critical success";

export function rollResult(total: number, natural: number): RollResult {
  if (natural === 1) return "critical fail";
  if (natural === 20) return "critical success";
  if (total <= 6) return "fail";
  if (total <= 13) return "mixed";
  return "success";
}

export function shuffle<T>(list: T[]): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
