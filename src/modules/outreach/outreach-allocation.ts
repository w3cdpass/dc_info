/**
 * Pure, side-effect-free allocation logic for a multi-session outreach wave.
 *
 * Given a contact list and a pool of WhatsApp sessions (each with a max capacity this wave derived
 * from its warm-up ramp aging), it round-robin balances the contacts across the pool, then splits
 * each session's share into bursts separated by cool-downs.
 *
 * The burst/cooldown *timing* is applied at runtime by the orchestrator (each session runs its own
 * pacing-serialized bulk pipeline, so sessions naturally proceed in parallel and overlap while one
 * cools). This file only produces the assignments, so it can be unit-tested deterministically.
 */

export interface OutreachContact {
  phone: string;
  name?: string;
}

export interface OutreachSession {
  id: string;
  name: string;
  /** Max recipients this session may take on this wave (derived from its warm-up ramp). */
  capacity: number;
}

export interface OutreachBurst {
  /** 0-based index of this burst within its session's timeline. */
  burstIndex: number;
  sessionId: string;
  sessionName: string;
  contacts: OutreachContact[];
}

export interface OutreachAllocation {
  /** Total unique recipients actually assigned (after capacity trimming). */
  totalAssigned: number;
  /** Per-session, the ordered list of bursts. */
  sessions: {
    id: string;
    name: string;
    assigned: number;
    capacity: number;
    bursts: OutreachBurst[];
  }[];
  /** Recipients that could not be assigned because the whole pool was at capacity. */
  unassigned: OutreachContact[];
}

/**
 * Round-robin distribute `contacts` across `sessions`.
 *
 * With `n` sessions, contact i goes to session (i % n), balancing counts to within one. A session
 * never receives more than its `capacity`; overflow contacts roll over to whichever sessions still
 * have headroom (round-robin among them), and anything with no headroom left is reported unassigned.
 */
export function distributeRoundRobin(
  contacts: OutreachContact[],
  sessions: OutreachSession[],
): Map<string, OutreachContact[]> {
  const bySession = new Map<string, OutreachContact[]>();
  for (const s of sessions) bySession.set(s.id, []);
  const totals = new Map<string, number>();
  for (const s of sessions) totals.set(s.id, 0);

  // Each session can accept max(n-1, 1) contacts before we start rolling over (so we never leave
  // headroom on one session while another session overflows in the same pass). A simple two-pass
  // approach: first fill each session's round-robin share capped at capacity; leftover contacts are
  // assigned round-robin to sessions with remaining headroom.
  const n = sessions.length;
  const cap = new Map(sessions.map(s => [s.id, s.capacity]));

  contacts.forEach((c, i) => {
    const target = sessions[i % n];
    if (totals.get(target.id)! < cap.get(target.id)!) {
      bySession.get(target.id)!.push(c);
      totals.set(target.id, totals.get(target.id)! + 1);
    } else {
      // rollover: try sessions round-robin starting after the nominal target
      assignWithHeadroom(c, bySession, totals, cap, sessions, n, i);
    }
  });

  return bySession;
}

function assignWithHeadroom(
  c: OutreachContact,
  bySession: Map<string, OutreachContact[]>,
  totals: Map<string, number>,
  cap: Map<string, number>,
  sessions: OutreachSession[],
  n: number,
  startIndex: number,
): boolean {
  for (let offset = 1; offset <= n; offset++) {
    const s = sessions[(startIndex + offset) % n];
    if (totals.get(s.id)! < cap.get(s.id)!) {
      bySession.get(s.id)!.push(c);
      totals.set(s.id, totals.get(s.id)! + 1);
      return true;
    }
  }
  return false;
}

/**
 * Warm-up ramp: the max sends allowed per day for an account of a given age in days, from a
 * schedule. Age is clamped to the schedule bounds (day 0 = first entry, last entry beyond the end).
 * Mirrors the send-pacing warm-up schedule semantics.
 */
export function warmupAllowanceForAge(warmupSchedule: number[], ageDays: number): number {
  if (!warmupSchedule.length) return Infinity;
  const idx = Math.max(0, Math.min(Math.floor(ageDays), warmupSchedule.length - 1));
  return warmupSchedule[idx];
}

/**
 * Split a single session's list into bursts of at most `burstSize` consecutive contacts.
 * `burstSize <= 0` means a single burst containing the whole list.
 */
export function chunkIntoBursts(contacts: OutreachContact[], burstSize: number): OutreachContact[][] {
  if (burstSize <= 0) {
    return contacts.length ? [contacts] : [];
  }
  const bursts: OutreachContact[][] = [];
  for (let i = 0; i < contacts.length; i += burstSize) {
    bursts.push(contacts.slice(i, i + burstSize));
  }
  return bursts;
}

/**
 * Full allocation: round-robin balance, capacity trim, and burst chunking.
 */
export function allocateOutreach(
  contacts: OutreachContact[],
  sessions: OutreachSession[],
  burstSize: number,
): OutreachAllocation {
  const bySession = distributeRoundRobin(contacts, sessions);
  const out: OutreachAllocation = {
    totalAssigned: 0,
    sessions: [],
    unassigned: [],
  };

  for (const [id, list] of bySession) {
    const meta = sessions.find(s => s.id === id)!;
    const bursts = chunkIntoBursts(list, burstSize).map((ct, i) => ({
      burstIndex: i,
      sessionId: id,
      sessionName: meta.name,
      contacts: ct,
    }));
    out.sessions.push({
      id,
      name: meta.name,
      assigned: list.length,
      capacity: meta.capacity,
      bursts,
    });
    out.totalAssigned += list.length;
  }

  // Determine unassigned: contacts not present in any session's list.
  const inPool = new Set<string>();
  for (const [id, list] of bySession) for (const c of list) inPool.add(`${id}:${c.phone}`);
  // A contact may have been placed in exactly one session during distribute; unassigned are those
  // whose phone never landed anywhere (rollover failed for every session).
  const assignedPhones = new Set<string>();
  for (const list of bySession.values()) for (const c of list) assignedPhones.add(c.phone);
  for (const c of contacts) {
    if (!assignedPhones.has(c.phone)) out.unassigned.push(c);
  }

  return out;
}
