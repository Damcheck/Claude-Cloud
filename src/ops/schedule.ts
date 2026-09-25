/**
 * One cron ("every 15 minutes") drives everything; this decides what's due in a tick.
 * Times are UTC. Each routine fires in the 15-minute bucket that contains its time.
 */
export type Routine = "watchers" | "brief" | "weekly_plan" | "weekly_retro" | "reflection" | "scout" | "consolidate" | "backup" | "cleanup";

interface Slot {
  routine: Routine;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday; omitted = every day. */
  weekday?: number;
}

export const SLOTS: Slot[] = [
  { routine: "consolidate", hour: 2, minute: 0 },
  { routine: "backup", hour: 3, minute: 0, weekday: 0 },
  { routine: "cleanup", hour: 4, minute: 0 },
  { routine: "brief", hour: 6, minute: 45 },
  { routine: "weekly_plan", hour: 7, minute: 0, weekday: 1 },
  { routine: "scout", hour: 9, minute: 0, weekday: 3 },
  { routine: "weekly_retro", hour: 16, minute: 0, weekday: 5 },
  { routine: "reflection", hour: 16, minute: 15, weekday: 5 },
];

export function dueRoutines(at: Date): Routine[] {
  const bucket = (m: number) => Math.floor(m / 15);
  const due: Routine[] = ["watchers"];
  for (const s of SLOTS) {
    if (s.weekday !== undefined && s.weekday !== at.getUTCDay()) continue;
    if (s.hour === at.getUTCHours() && bucket(s.minute) === bucket(at.getUTCMinutes())) due.push(s.routine);
  }
  return due;
}
