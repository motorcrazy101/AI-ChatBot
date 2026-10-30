import { ActivityType, Client } from "discord.js";
import { StatusSetting, StatusType } from "./types";

/** Custom status shown under the bot's name in the member list. */

const ACTIVITY_TYPES: Record<StatusType, ActivityType> = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

const PREFIXES: [string, StatusType][] = [
  ["playing ", "playing"],
  ["watching ", "watching"],
  ["listening to ", "listening"],
  ["competing in ", "competing"],
];

/**
 * Turns text like "Playing in the Asylum" or "Watching you sleep" into a
 * status. Anything without one of those starting words becomes a plain
 * custom status.
 */
export function parseStatus(text: string): StatusSetting {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const [prefix, type] of PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { type, text: trimmed.slice(prefix.length).trim() };
    }
  }
  return { type: "custom", text: trimmed };
}

/** How the status reads in Discord, e.g. "Listening to the rain". */
export function describeStatus(status: StatusSetting): string {
  if (!status.text) return "(no status)";
  switch (status.type) {
    case "playing":
      return `Playing ${status.text}`;
    case "watching":
      return `Watching ${status.text}`;
    case "listening":
      return `Listening to ${status.text}`;
    case "competing":
      return `Competing in ${status.text}`;
    default:
      return status.text;
  }
}

export function applyStatus(client: Client<true>, status: StatusSetting): void {
  if (!status.text) {
    client.user.setPresence({ activities: [], status: "online" });
    return;
  }
  const type = ACTIVITY_TYPES[status.type];
  const activity =
    type === ActivityType.Custom
      ? { name: "Custom Status", state: status.text, type }
      : { name: status.text, type };
  client.user.setPresence({ activities: [activity], status: "online" });
}
