/**
 * Exportable evidence bundle and its offline verifier.
 *
 * A bundle answers three separate questions, and this module keeps them separate because
 * collapsing them is how a reassuring "verified" gets printed for a file that proves nothing:
 *
 *   1. RULES REPRODUCED      — do the recorded rows hash to the recorded commitments, and does
 *                              replaying the agreed rules give the recorded verdict?
 *   2. INTERNALLY CONSISTENT — does every value the bundle repeats for human consumption (the
 *                              displayed recipient, amount, status, parties, chain, addresses,
 *                              balance deltas) agree with the terms it also carries? The review
 *                              of 14 September 2026 rewrote exactly these display fields and the
 *                              verifier still said ok.
 *   3. SETTLEMENT VERIFIED   — did the recorded transactions actually happen, on the right chain,
 *                              against the right contracts, for this job, moving this asset to
 *                              this recipient in this amount? Only `scripts/verify-bundle.ts`
 *                              with `--rpc` can answer this, and an unanswered question is
 *                              reported as NOT CHECKED, never as passed.
 */
import { canonicalDigest, termsDigest, type TermsForDigest } from "./encoding.ts";
import { packDigest, canonicalPackJson, type AcceptancePack } from "./pack.ts";
import { validateAgreement } from "./agreement.ts";
import { deriveMovements, expectedMovementCounts } from "./transfers.ts";
import { check } from "./policy.ts";
import type { RecordRow } from "./types.ts";

/** One ERC-20 movement of the approved token into or out of the escrow, for this job. */
export interface ObservedTransfer {
  txHash: string;
  step: string;
  logIndex: number;
  from: string;
  to: string;
  value: string;
  direction: "in" | "out";
}

/**
 * What actually moved for this job, derived from this job's own transaction receipts.
 *
 * Not a difference between wallet balances. An earlier version computed each job's "balance
 * changes" as (wallet balance now − wallet balance when the job was created), which silently
 * absorbed every later or concurrent job: finishing a second job made the first one report double,
 * and its genuine evidence then failed verification.
 */
export interface ObservedTransfers {
  paymentToken: string;
  escrow: string;
  transfers: ObservedTransfer[];
  /** Total of the approved token moved into the escrow by this job's transactions. */
  fundedIn: string;
  /** Total moved out of the escrow by this job's transactions. */
  paidOut: string;
  /** Who received the outgoing movement, if there was exactly one recipient. */
  paidTo: string | null;
}

export interface EvidenceTx {
  step: string;
  hash: string;
  blockNumber: number;
  gasUsed: string;
  from: string;
  to: string | null;
  status: number;
}

/** Everything in a bundle is JSON-safe: large integers are decimal strings, never JSON numbers. */
export interface SerializedTerms {
  chainId: string;
  escrow: string;
  jobId: string;
  buyer: string;
  provider: string;
  paymentToken: string;
  amount: string;
  sourceDigest: string;
  requiredRowCount: number;
  policyId: string;
  policyVersion: number;
  ruleMask: number;
  packDigest: string;
  deliveryDeadline: string;
  settlementExpiry: string;
}

export function deserializeTerms(t: SerializedTerms): TermsForDigest {
  return {
    ...t,
    chainId: BigInt(t.chainId),
    jobId: BigInt(t.jobId),
    amount: BigInt(t.amount),
    deliveryDeadline: BigInt(t.deliveryDeadline),
    settlementExpiry: BigInt(t.settlementExpiry),
  };
}

export interface EvidenceBundle {
  bundleFormat: "acceptance-evidence/v1";
  exportedAt: string;
  build: { solcVersion: string; sourcesHash: string; encodingVersion: number; codeRevision: string };
  chain: { chainId: number; label: string; escrow: string; policy: string; paymentToken: string };
  job: {
    jobId: string;
    status: string;
    buyer: string;
    provider: string;
    amountBaseUnits: string;
    tokenSymbol: string;
    tokenDecimals: number;
    createdAt: number;
    deliveryDeadline: number;
    settlementExpiry: number;
    submittedAt: number;
    settledAt: number;
  };
  pack: AcceptancePack;
  commitments: { packDigest: string; sourceDigest: string; deliveryDigest: string; termsDigest: string };
  terms: SerializedTerms;
  source: { productId: string; priceCents: string }[];
  delivery: { productId: string; priceCents: string }[] | null;
  recordedVerdict: { verdict: number; verdictName: string; ruleId: number; failCode: number; detailA: string; detailB: string };
  transactions: EvidenceTx[];
  /** Derived from `observedTransfers`. Attributable to this job and to no other. */
  balanceDeltas: Record<string, string>;
  observedTransfers: ObservedTransfers;
  /**
   * Current wallet totals at export time, for context only. These include every other job and any
   * unrelated activity, and are deliberately kept separate from the per-job figures above.
   */
  currentWalletBalances: Record<string, string>;
  caveats: string[];
}

export const BUNDLE_CAVEATS = [
  "Local simulation. Synthetic data, disposable accounts, a mock ERC-20 with no value, and no real money.",
  "Every participant in this record is controlled by one operator. Nothing here is an arms-length transaction.",
  "Replaying this bundle reproduces the checks. It does not prove that the recorded payment occurred: for that, verify the transaction hashes against chain receipts.",
  "The commitment covers the canonical typed bundle described in docs/encoding.md, not an arbitrary raw file byte for byte.",
  "Passing these checks demonstrates engineering behaviour. It is not evidence of customer demand, of a dispute rate, or that checking is cheaper than fulfilment.",
];

export const rowsOut = (rows: readonly RecordRow[]) =>
  rows.map((r) => ({ productId: r.productId.toString(), priceCents: r.priceCents.toString() }));
export const rowsIn = (rows: { productId: string; priceCents: string }[]): RecordRow[] =>
  rows.map((r) => ({ productId: BigInt(r.productId), priceCents: BigInt(r.priceCents) }));

export interface VerificationLine {
  name: string;
  ok: boolean;
  detail: string;
}

export type SectionVerdict = "PASS" | "FAIL" | "NOT_CHECKED";

export interface VerificationSection {
  key: "rulesReproduced" | "internallyConsistent" | "settlementVerified";
  title: string;
  verdict: SectionVerdict;
  lines: VerificationLine[];
}

export interface VerificationReport {
  /** True only when both offline sections pass. It says nothing about settlement. */
  ok: boolean;
  sections: VerificationSection[];
  /** Flattened, for callers that only want the list. */
  lines: VerificationLine[];
  notVerified: string[];
}

/** Offline verification. Touches no network, and never claims anything about settlement. */
export function verifyBundle(b: EvidenceBundle): VerificationReport {
  const rules: VerificationLine[] = [];
  const consistency: VerificationLine[] = [];
  const addRule = (name: string, ok: boolean, detail: string) => rules.push({ name, ok, detail });
  const addConsistency = (name: string, ok: boolean, detail: string) => consistency.push({ name, ok, detail });

  const fail = (message: string): VerificationReport => ({
    ok: false,
    sections: [
      { key: "rulesReproduced", title: "rules reproduced", verdict: "FAIL", lines: [{ name: "bundle format", ok: false, detail: message }] },
      { key: "internallyConsistent", title: "bundle internally consistent", verdict: "FAIL", lines: [] },
      { key: "settlementVerified", title: "on-chain settlement", verdict: "NOT_CHECKED", lines: [] },
    ],
    lines: [{ name: "bundle format", ok: false, detail: message }],
    notVerified: [],
  });

  if (b?.bundleFormat !== "acceptance-evidence/v1") {
    return fail(`unrecognised bundle format ${JSON.stringify(b?.bundleFormat)}`);
  }
  if (!b.terms || !b.commitments || !b.job || !b.chain || !b.pack) {
    return fail("the bundle is missing one of terms, commitments, job, chain or pack");
  }

  const terms = deserializeTerms(b.terms);

  // ------------------------------------------------- 1. rules reproduced
  const source = rowsIn(b.source);
  const recomputedSource = canonicalDigest(source);
  addRule("source commitment", recomputedSource === b.commitments.sourceDigest,
    recomputedSource === b.commitments.sourceDigest ? recomputedSource : `${recomputedSource} != recorded ${b.commitments.sourceDigest}`);

  const recomputedPack = packDigest(b.pack);
  addRule("acceptance pack commitment", recomputedPack === b.commitments.packDigest,
    recomputedPack === b.commitments.packDigest ? recomputedPack : `${recomputedPack} != recorded ${b.commitments.packDigest}`);

  const agreement = validateAgreement({
    pack: b.pack,
    terms,
    storedTermsDigest: b.commitments.termsDigest,
    createdAt: b.job.createdAt ?? 0,
    sourceRows: source,
  });
  addRule("agreement validates against the terms", agreement.ok,
    agreement.ok ? "pack, terms and stored source all describe the same job" : agreement.summary);

  const recomputedTerms = termsDigest(terms);
  addRule("terms digest", recomputedTerms === b.commitments.termsDigest,
    recomputedTerms === b.commitments.termsDigest ? recomputedTerms : `${recomputedTerms} != recorded ${b.commitments.termsDigest}`);

  let replayVerdictName = "INDETERMINATE";
  if (b.delivery) {
    const delivery = rowsIn(b.delivery);
    const recomputedDelivery = canonicalDigest(delivery);
    addRule("delivery commitment", recomputedDelivery === b.commitments.deliveryDigest,
      recomputedDelivery === b.commitments.deliveryDigest ? recomputedDelivery : `${recomputedDelivery} != recorded ${b.commitments.deliveryDigest}`);

    const replay = check(source, delivery, terms.requiredRowCount, terms.ruleMask);
    replayVerdictName = replay.result.verdictName;
    const matches =
      replay.result.verdict === b.recordedVerdict.verdict &&
      replay.result.ruleId === b.recordedVerdict.ruleId &&
      replay.result.failCode === b.recordedVerdict.failCode;
    addRule("recorded verdict reproduces", matches,
      matches ? replay.headline : `replay says ${replay.result.verdictName}/rule ${replay.result.ruleId}, record says ${b.recordedVerdict.verdictName}/rule ${b.recordedVerdict.ruleId}`);
  } else {
    addRule("delivery commitment", b.commitments.deliveryDigest === ZERO_DIGEST,
      "no delivery was submitted for this job");
  }

  // -------------------------------------- 2. internal consistency of the record
  //
  // Everything the bundle repeats for a reader must agree with the terms it also carries.
  // Rewriting a display field is the cheapest possible forgery and must not survive.
  const eq = (a: string | undefined, c: string | undefined) => !!a && !!c && a.toLowerCase() === c.toLowerCase();
  const eqAddr = (a: string | null | undefined, c: string | null | undefined) =>
    !!a && !!c && a.toLowerCase() === c.toLowerCase();

  addConsistency("displayed job id matches the terms", b.job.jobId === terms.jobId.toString(),
    `job ${b.job.jobId} vs terms ${terms.jobId}`);
  addConsistency("displayed buyer matches the terms", eq(b.job.buyer, terms.buyer),
    `${b.job.buyer} vs ${terms.buyer}`);
  addConsistency("displayed provider matches the terms", eq(b.job.provider, terms.provider),
    `${b.job.provider} vs ${terms.provider}`);
  addConsistency("displayed amount matches the terms", b.job.amountBaseUnits === terms.amount.toString(),
    `${b.job.amountBaseUnits} vs ${terms.amount}`);
  addConsistency("displayed token decimals match the pack", b.job.tokenDecimals === b.pack.payment.tokenDecimals,
    `${b.job.tokenDecimals} vs ${b.pack.payment.tokenDecimals}`);
  addConsistency("displayed deadlines match the terms",
    b.job.deliveryDeadline === Number(terms.deliveryDeadline) && b.job.settlementExpiry === Number(terms.settlementExpiry),
    `delivery ${b.job.deliveryDeadline}/${terms.deliveryDeadline}, expiry ${b.job.settlementExpiry}/${terms.settlementExpiry}`);
  addConsistency("terms bind this chain, escrow and job",
    Number(terms.chainId) === b.chain.chainId && eq(terms.escrow, b.chain.escrow) && terms.jobId.toString() === b.job.jobId,
    `chain ${terms.chainId}, escrow ${terms.escrow}, job ${terms.jobId}`);
  addConsistency("terms name the recorded payment token", eq(terms.paymentToken, b.chain.paymentToken),
    `${terms.paymentToken} vs ${b.chain.paymentToken}`);

  const verdictNames = ["INDETERMINATE", "PASS", "FAIL"];
  addConsistency("recorded verdict name matches its code",
    b.recordedVerdict.verdictName === verdictNames[b.recordedVerdict.verdict],
    `${b.recordedVerdict.verdictName} vs code ${b.recordedVerdict.verdict}`);

  const expectedStatus = STATUS_FOR_VERDICT[b.recordedVerdict.verdict] ?? [];
  const statusOk = b.job.status === "EXPIRED"
    ? b.recordedVerdict.verdict === 0
    : expectedStatus.includes(b.job.status);
  addConsistency("displayed status matches the recorded verdict", statusOk,
    `status ${b.job.status} against verdict ${b.recordedVerdict.verdictName}`);

  // ---- movements: every summary re-derived from the movement list it claims to summarise ----
  const amount = terms.amount;
  const observed = b.observedTransfers;
  if (!observed || !Array.isArray(observed.transfers)) {
    addConsistency("per-job movements are recorded", false,
      "the bundle carries no observedTransfers; its balance figures cannot be attributed to this job");
  } else {
    const recordedHashes = new Set((b.transactions ?? []).map((t) => t.hash.toLowerCase()));
    addConsistency("every recorded movement belongs to a recorded transaction",
      observed.transfers.every((t) => recordedHashes.has(String(t.txHash).toLowerCase())),
      `${observed.transfers.length} movement(s)`);
    addConsistency("the movement list names this escrow and this token",
      eqAddr(observed.escrow, b.chain.escrow) && eqAddr(observed.paymentToken, b.chain.paymentToken),
      `${observed.escrow} / ${observed.paymentToken}`);

    // One derivation. Everything below is compared against it; nothing is taken on trust.
    const roles: Record<string, string> = {
      buyer: b.job.buyer, provider: b.job.provider, escrow: b.chain.escrow,
    };
    const derived = deriveMovements(observed.transfers, b.chain.escrow, roles);

    addConsistency("the movement list is well formed", derived.issues.length === 0,
      derived.issues.length ? derived.issues.join("; ") : "each movement involves the escrow once, with a direction its addresses support");

    // The summaries must be what those movements actually add up to. Checking them against the
    // agreement alone let an empty or halved list sit beside a summary claiming a full payment.
    const summaryProblems: string[] = [];
    if (String(observed.fundedIn) !== derived.fundedIn) {
      summaryProblems.push(`fundedIn says ${observed.fundedIn}, movements total ${derived.fundedIn}`);
    }
    if (String(observed.paidOut) !== derived.paidOut) {
      summaryProblems.push(`paidOut says ${observed.paidOut}, movements total ${derived.paidOut}`);
    }
    const claimedTo = observed.paidTo ?? null;
    if ((claimedTo === null) !== (derived.paidTo === null) ||
        (claimedTo !== null && derived.paidTo !== null && !eqAddr(claimedTo, derived.paidTo))) {
      summaryProblems.push(`paidTo says ${claimedTo}, movements show ${derived.paidTo}`);
    }
    addConsistency("the reported totals are what the movements add up to", summaryProblems.length === 0,
      summaryProblems.length ? summaryProblems.join("; ") : `in ${derived.fundedIn}, out ${derived.paidOut} to ${derived.paidTo ?? "nobody"}`);

    // The headline deltas must come from the same movements.
    const deltaProblems = Object.entries(derived.net)
      .filter(([role, v]) => String(b.balanceDeltas?.[role] ?? "0") !== v)
      .map(([role, v]) => `${role}: recorded ${b.balanceDeltas?.[role]} vs movements ${v}`);
    addConsistency("balance changes equal the movements they are derived from",
      deltaProblems.length === 0,
      deltaProblems.length ? deltaProblems.join("; ") : "buyer, provider and escrow all reconcile");

    // And the derived result must match the agreement and the job's state.
    const counts = expectedMovementCounts(b.job.status);
    addConsistency("the job's state has the movements it requires",
      !!counts && derived.inCount === counts.in && derived.outCount === counts.out,
      counts
        ? `${b.job.status} needs ${counts.in} in and ${counts.out} out; found ${derived.inCount} and ${derived.outCount}`
        : `unrecognised status ${b.job.status}`);

    const terminal = ["PAID", "REJECTED", "EXPIRED"].includes(b.job.status);
    if (terminal) {
      addConsistency("the escrow was funded for the agreed amount",
        BigInt(derived.fundedIn) === amount, `${derived.fundedIn} in against an agreed ${amount}`);
      const expectedRecipient = b.job.status === "PAID" ? b.job.provider : b.job.buyer;
      addConsistency("the payout was the agreed amount, to the party this outcome requires",
        BigInt(derived.paidOut) === amount && !!derived.paidTo && eqAddr(derived.paidTo, expectedRecipient),
        `${derived.paidOut} out to ${derived.paidTo}, expected ${amount} to ${expectedRecipient}`);
    }
  }

  // ---- timestamps: internally possible. The RPC section establishes the actual values. ----
  const { createdAt, submittedAt, settledAt, deliveryDeadline, settlementExpiry, status } = b.job;
  const ints = [createdAt, submittedAt, settledAt].every((v) => Number.isInteger(v) && v >= 0);
  const problems: string[] = [];
  if (!ints) problems.push("timestamps must be non-negative integers");
  else {
    if (createdAt <= 0) problems.push("createdAt is unset");
    if (submittedAt !== 0 && submittedAt < createdAt) problems.push("submitted before created");
    if (settledAt !== 0 && settledAt < createdAt) problems.push("settled before created");
    if (submittedAt !== 0 && settledAt !== 0 && settledAt < submittedAt) problems.push("settled before submitted");
    if (submittedAt !== 0 && submittedAt > deliveryDeadline) problems.push("submitted after the delivery deadline, which the contract forbids");
    if (["PAID", "REJECTED"].includes(status)) {
      if (submittedAt === 0) problems.push(`${status} with no submission time`);
      if (settledAt === 0) problems.push(`${status} with no settlement time`);
      if (settledAt >= settlementExpiry) problems.push("settled at or after expiry, which the contract forbids");
    }
    if (status === "EXPIRED") {
      if (settledAt === 0) problems.push("EXPIRED with no settlement time");
      if (settledAt !== 0 && settledAt < settlementExpiry) problems.push("expired before the settlement expiry");
    }
  }
  addConsistency("timestamps are internally possible", problems.length === 0,
    problems.length ? problems.join("; ") : `created ${createdAt}, submitted ${submittedAt}, settled ${settledAt}`);

  addConsistency("transaction records are well formed",
    Array.isArray(b.transactions) &&
      b.transactions.every((t) => /^0x[0-9a-fA-F]{64}$/.test(t.hash) && Number.isInteger(t.blockNumber)),
    `${b.transactions?.length ?? 0} transaction(s)`);

  addConsistency("no key material present",
    !/privateKey|mnemonic|secretKey/i.test(JSON.stringify(b)), "no key-like fields");

  const notVerified = [
    "Whether any payment actually occurred. That is the third section, and it requires --rpc against the chain named in the bundle.",
    "Whether the source data is true of the world. The source is an agreed reference, not an independently verified fact.",
    ...(b.pack.clauses.some((c) => c.coverage === "EXCLUDED_BY_REVISION")
      ? ["Clauses excluded by scope revision were never checked, by agreement. They are listed in the pack."]
      : []),
  ];

  const rulesOk = rules.every((l) => l.ok);
  const consistencyOk = consistency.every((l) => l.ok);
  return {
    ok: rulesOk && consistencyOk,
    sections: [
      { key: "rulesReproduced", title: "rules reproduced", verdict: rulesOk ? "PASS" : "FAIL", lines: rules },
      { key: "internallyConsistent", title: "bundle internally consistent", verdict: consistencyOk ? "PASS" : "FAIL", lines: consistency },
      { key: "settlementVerified", title: "on-chain settlement", verdict: "NOT_CHECKED", lines: [] },
    ],
    lines: [...rules, ...consistency],
    notVerified,
  };
}

const ZERO_DIGEST = `0x${"0".repeat(64)}`;
const STATUS_FOR_VERDICT: Record<number, string[]> = {
  0: ["CREATED", "ACCEPTED", "FUNDED", "SUBMITTED", "EXPIRED", "CANCELLED"],
  1: ["PAID"],
  2: ["REJECTED"],
};

/** Stable serialisation so a bundle file can itself be hashed and compared. */
export function bundleJson(b: EvidenceBundle): string {
  return JSON.stringify(b, null, 2);
}

export { canonicalPackJson };
