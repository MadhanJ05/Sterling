/**
 * One pure derivation of what a job's recorded movements add up to.
 *
 * The fourth independent review found the exporter and the offline verifier telling two stories
 * that were never compared: the verifier recomputed net balance changes from the movement list,
 * and separately compared the supplied `fundedIn`/`paidOut`/`paidTo` summaries against the
 * agreement — but never checked that those summaries came from that list. A bundle could carry no
 * movements at all, or half-size ones, and still claim a full payment.
 *
 * So there is now exactly one calculation. The exporter uses it to produce its summary, and the
 * offline verifier uses it to re-derive that summary from the movements and compare. The RPC
 * verifier uses it too, but on a movement list it builds itself from chain receipts, so its
 * comparison stays independent of anything the bundle asserts.
 *
 * Direction is always derived from the addresses. A supplied direction is never trusted; it is
 * compared with the derived one and a contradiction is an error.
 */

export interface MovementRecord {
  txHash: string;
  step: string;
  logIndex: number;
  from: string;
  to: string;
  value: string;
  direction: "in" | "out";
}

export interface DerivedMovements {
  fundedIn: string;
  paidOut: string;
  paidTo: string | null;
  inCount: number;
  outCount: number;
  net: Record<string, string>;
  /** Structural problems found while deriving. Any entry makes the movement list untrustworthy. */
  issues: string[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * @param transfers the recorded movements
 * @param escrow    the escrow whose inbound/outbound movements these are
 * @param roles     role name -> address, for the net figures
 */
export function deriveMovements(
  transfers: readonly MovementRecord[],
  escrow: string,
  roles: Record<string, string>,
): DerivedMovements {
  const issues: string[] = [];
  const net: Record<string, bigint> = {};
  for (const role of Object.keys(roles)) net[role] = 0n;

  let fundedIn = 0n;
  let paidOut = 0n;
  let inCount = 0;
  let outCount = 0;
  const recipients = new Set<string>();
  const seen = new Set<string>();
  let lastOutTo: string | null = null;

  transfers.forEach((t, index) => {
    const id = `${String(t.txHash).toLowerCase()}:${t.logIndex}`;
    if (seen.has(id)) {
      issues.push(`movement ${index} repeats (transaction, log) ${id}`);
      return;
    }
    seen.add(id);

    let value: bigint;
    try {
      value = BigInt(t.value);
    } catch {
      issues.push(`movement ${index} has a non-integer value ${JSON.stringify(t.value)}`);
      return;
    }
    if (value < 0n) {
      issues.push(`movement ${index} has a negative value`);
      return;
    }

    const toEscrow = eq(t.to, escrow);
    const fromEscrow = eq(t.from, escrow);
    if (toEscrow && fromEscrow) {
      issues.push(`movement ${index} is the escrow paying itself`);
      return;
    }
    if (!toEscrow && !fromEscrow) {
      issues.push(`movement ${index} does not involve the escrow ${escrow}`);
      return;
    }

    // Derived from the addresses, never taken from the record.
    const derivedDirection: "in" | "out" = toEscrow ? "in" : "out";
    if (t.direction !== derivedDirection) {
      issues.push(
        `movement ${index} claims direction "${t.direction}" but ${t.from} -> ${t.to} is "${derivedDirection}"`,
      );
    }

    if (derivedDirection === "in") {
      fundedIn += value;
      inCount++;
    } else {
      paidOut += value;
      outCount++;
      recipients.add(t.to.toLowerCase());
      lastOutTo = t.to;
    }

    for (const [role, address] of Object.entries(roles)) {
      if (eq(t.from, address)) net[role] = (net[role] ?? 0n) - value;
      if (eq(t.to, address)) net[role] = (net[role] ?? 0n) + value;
    }
  });

  return {
    fundedIn: fundedIn.toString(),
    paidOut: paidOut.toString(),
    paidTo: recipients.size === 1 ? lastOutTo : null,
    inCount,
    outCount,
    net: Object.fromEntries(Object.entries(net).map(([k, v]) => [k, v.toString()])),
    issues,
  };
}

/** How many movements each job status must have. The supported flow has exactly one of each. */
export function expectedMovementCounts(status: string): { in: number; out: number } | null {
  switch (status) {
    case "CREATED":
    case "ACCEPTED":
    case "CANCELLED":
      return { in: 0, out: 0 };
    case "FUNDED":
    case "SUBMITTED":
      return { in: 1, out: 0 };
    case "PAID":
    case "REJECTED":
    case "EXPIRED":
      return { in: 1, out: 1 };
    default:
      return null;
  }
}
