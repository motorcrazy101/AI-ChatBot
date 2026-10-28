import { Message } from "discord.js";

/**
 * Stops bots from talking to each other forever.
 *
 * Every bot client in this process sees the same messages, so state is shared
 * and each message is only counted once (by ID). A human message resets the
 * count for that channel; so does 10 minutes of silence.
 */

const INACTIVITY_RESET_MS = 10 * 60 * 1000;

interface ChainState {
  consecutiveBotMessages: number;
  lastMessageId: bigint;
  lastActivity: number;
}

const chains = new Map<string, ChainState>();

export function recordMessage(message: Message): void {
  const id = BigInt(message.id);
  const now = Date.now();
  const state = chains.get(message.channelId);

  // Already counted by another bot client (or an older, out-of-order event)
  if (state && id <= state.lastMessageId) return;

  const expired = !state || now - state.lastActivity > INACTIVITY_RESET_MS;
  const previous = expired ? 0 : state.consecutiveBotMessages;

  chains.set(message.channelId, {
    consecutiveBotMessages: message.author.bot ? previous + 1 : 0,
    lastMessageId: id,
    lastActivity: now,
  });
}

export function botChainTooLong(channelId: string, max: number): boolean {
  const state = chains.get(channelId);
  return !!state && state.consecutiveBotMessages >= max;
}

/** Drop channels that have been quiet for a while so the map can't grow forever. */
export function pruneChains(): void {
  const cutoff = Date.now() - INACTIVITY_RESET_MS;
  for (const [channelId, state] of chains) {
    if (state.lastActivity < cutoff) chains.delete(channelId);
  }
}
