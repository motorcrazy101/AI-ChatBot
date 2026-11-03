import { getSettings } from "./settings";
import { formatClock, minutesOfDay, zonedParts } from "./time";
import { StatusSetting } from "./types";

/**
 * Sleep schedule: she "sleeps" at night (status 😴 Sleeping, groggy replies
 * if you wake her) and is drowsy for two hours after waking up.
 * Times come from /aurora sleep or SLEEP_BEDTIME / SLEEP_WAKE.
 */

export type SleepPhase = "asleep" | "waking" | "awake";

const WAKING_MINUTES = 120;

/** True if `now` is in [start, end), handling ranges that cross midnight. */
function inRange(now: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function currentPhase(botId: string): SleepPhase {
  const { enabled, bedtime, wake } = getSettings(botId).sleep;
  if (!enabled) return "awake";

  const now = minutesOfDay(zonedParts().time);
  const bed = minutesOfDay(bedtime);
  const up = minutesOfDay(wake);

  if (inRange(now, bed, up)) return "asleep";
  if (inRange(now, up, (up + WAKING_MINUTES) % 1440)) return "waking";
  return "awake";
}

/** Status shown while asleep / just woken up, or null for her normal status. */
export function phaseStatus(phase: SleepPhase): StatusSetting | null {
  if (phase === "asleep") return { type: "custom", text: "😴 Sleeping" };
  if (phase === "waking") return { type: "custom", text: "☕ Just woke up" };
  return null;
}

/** A hint for Kindroid so replies match the time of day. */
export function sleepNote(botId: string): string | null {
  const phase = currentPhase(botId);
  const clock = formatClock(zonedParts().time);
  if (phase === "asleep") {
    return (
      `It's ${clock} and you were fast asleep — this message just woke you up. ` +
      "Reply sleepy and groggy (yawning, mumbling, maybe a little grumpy or cute about being woken)."
    );
  }
  if (phase === "waking") {
    return `It's ${clock} and you only just woke up — still a bit drowsy, maybe with your morning coffee.`;
  }
  return null;
}
