/**
 * The acceptance pack: the agreement both parties approve before work starts.
 *
 * It holds the clause list, each clause's coverage classification, the frozen rule set, the
 * checker identity, and the payment/expiry policy. The contract does not parse the pack; it binds
 * keccak256 of its canonical JSON into the terms digest.
 *
 * A clause that is not EXECUTABLE blocks the automatic flow. The only route forward is an
 * explicit scope revision, which produces a new pack version where the clause is still listed,
 * marked EXCLUDED_BY_REVISION, with its reason. Clauses are never removed silently.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { ALL_RULES, POLICY_ID_PREIMAGE, POLICY_VERSION, RULES, type RecordRow } from "./types.ts";
import { POLICY_ID, canonicalDigest } from "./encoding.ts";

export type Coverage = "EXECUTABLE" | "EXTERNAL_ASSERTION" | "JUDGEMENT" | "EXCLUDED_BY_REVISION";

export interface Clause {
  id: string;
  text: string;
  coverage: Coverage;
  ruleId: number | null;
  note: string;
}

export interface PaymentPolicy {
  /** Display only. A symbol identifies nothing: the address below is the payment asset. */
  tokenSymbol: string;
  /** The ERC-20 contract address the payment must use. Checked against the escrow's approved token. */
  paymentToken: string;
  tokenDecimals: number;
  amountBaseUnits: string;
  deliveryWindowSeconds: number;
  settlementWindowSeconds: number;
}

export interface AcceptancePack {
  packFormat: typeof PACK_FORMAT;
  templateId: string;
  templateVersion: number;
  packVersion: number;
  title: string;
  checkerPolicyIdPreimage: string;
  checkerPolicyId: string;
  checkerPolicyVersion: number;
  ruleMask: number;
  sourceDigest: string;
  requiredRowCount: number;
  clauses: Clause[];
  payment: PaymentPolicy;
  revisionHistory: string[];
}

export interface CoverageReport {
  total: number;
  executable: number;
  externalAssertion: number;
  judgement: number;
  excludedByRevision: number;
  unsupportedClauseCount: number;
  fullyAutomatic: boolean;
  summary: string;
}

export const TEMPLATE_ID = "catalogue-normalization";
export const TEMPLATE_VERSION = 1;

/**
 * Bumped from v1 when `paymentToken` was added. v1 named only a token *symbol*, which identifies
 * nothing: two different contracts can both call themselves mUSD. A v1 pack is not accepted.
 */
export const PACK_FORMAT = "acceptance-pack/v2" as const;

/**
 * The four executable clauses, one per frozen rule. Fixed for version 1.
 *
 * Exported as the single source of canonical clause text: `validateAgreement` regenerates it and
 * refuses any clause labelled EXECUTABLE whose text is not exactly what this function produces.
 * A label is not evidence that a check exists; matching the template is.
 */
export function templateClauses(requiredRowCount: number): Clause[] {
  const byRule = (id: number) => RULES.find((r) => r.id === id)!;
  return [
    {
      id: "C1",
      text: `The result contains exactly ${requiredRowCount} rows.`,
      coverage: "EXECUTABLE",
      ruleId: 1,
      note: `Executable as rule 1 (${byRule(1).technical}).`,
    },
    {
      id: "C2",
      text: "Every product in the approved source appears exactly once, and no other product appears.",
      coverage: "EXECUTABLE",
      ruleId: 2,
      note: `Executable as rule 2 (${byRule(2).technical}).`,
    },
    {
      id: "C3",
      text: "Every price is exactly the price in the approved source.",
      coverage: "EXECUTABLE",
      ruleId: 3,
      note: `Executable as rule 3 (${byRule(3).technical}). Source prices are agreed reference values, not independently verified market prices.`,
    },
    {
      id: "C4",
      text: "Rows are sorted by product ID in strictly increasing order.",
      coverage: "EXECUTABLE",
      ruleId: 4,
      note: `Executable as rule 4 (${byRule(4).technical}).`,
    },
  ];
}

/** The deliberate counter-example the interface must show. */
export const SUBJECTIVE_CLAUSE: Clause = {
  id: "C5",
  text: "Make the product descriptions persuasive.",
  coverage: "JUDGEMENT",
  ruleId: null,
  note:
    "Not executable. 'Persuasive' has no committed predicate: two competent reviewers can disagree " +
    "on the same bytes, and no check in this pack can settle it. This clause is shown, not hidden, " +
    "and it blocks the automatic flow until the parties explicitly revise scope.",
};

export interface BuildPackOptions {
  title: string;
  source: readonly RecordRow[];
  payment: PaymentPolicy;
  includeSubjectiveClause?: boolean;
}

export function buildPack(opts: BuildPackOptions): AcceptancePack {
  const clauses = templateClauses(opts.source.length);
  if (opts.includeSubjectiveClause) clauses.push({ ...SUBJECTIVE_CLAUSE });
  return {
    packFormat: PACK_FORMAT,
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    packVersion: 1,
    title: opts.title,
    checkerPolicyIdPreimage: POLICY_ID_PREIMAGE,
    checkerPolicyId: POLICY_ID,
    checkerPolicyVersion: POLICY_VERSION,
    ruleMask: ALL_RULES,
    sourceDigest: canonicalDigest(opts.source),
    requiredRowCount: opts.source.length,
    clauses,
    payment: opts.payment,
    revisionHistory: [],
  };
}

export function coverage(pack: AcceptancePack): CoverageReport {
  const count = (c: Coverage) => pack.clauses.filter((x) => x.coverage === c).length;
  const executable = count("EXECUTABLE");
  const externalAssertion = count("EXTERNAL_ASSERTION");
  const judgement = count("JUDGEMENT");
  const excludedByRevision = count("EXCLUDED_BY_REVISION");
  const unsupportedClauseCount = externalAssertion + judgement;
  const fullyAutomatic = unsupportedClauseCount === 0;
  return {
    total: pack.clauses.length,
    executable,
    externalAssertion,
    judgement,
    excludedByRevision,
    unsupportedClauseCount,
    fullyAutomatic,
    summary: fullyAutomatic
      ? `${executable} of ${pack.clauses.length} clauses are executable` +
        (excludedByRevision ? `, ${excludedByRevision} excluded by an explicit scope revision.` : ".")
      : `${unsupportedClauseCount} clause(s) cannot be checked by software (${judgement} requiring judgement, ${externalAssertion} depending on an external assertion). This pack cannot enter the automatic flow.`,
  };
}

/**
 * Explicit scope revision. Produces a NEW pack version. The clause stays visible and is marked,
 * never deleted. An existing job keeps the pack digest it was created with; a revision cannot
 * reach back into it.
 */
export function reviseScope(pack: AcceptancePack, clauseId: string, reason: string): AcceptancePack {
  const target = pack.clauses.find((c) => c.id === clauseId);
  if (!target) throw new Error(`No clause ${clauseId} in this pack.`);
  if (target.coverage === "EXECUTABLE") {
    throw new Error(`Clause ${clauseId} is executable. Scope revision is for clauses software cannot check.`);
  }
  if (target.coverage === "EXCLUDED_BY_REVISION") throw new Error(`Clause ${clauseId} is already excluded.`);
  return {
    ...pack,
    packVersion: pack.packVersion + 1,
    clauses: pack.clauses.map((c) =>
      c.id === clauseId
        ? {
            ...c,
            coverage: "EXCLUDED_BY_REVISION" as const,
            note:
              `Excluded from automatic acceptance by explicit revision to pack version ${pack.packVersion + 1}. ` +
              `Original classification: ${c.coverage}. Reason: ${reason}. ` +
              `Payment under this pack does not depend on this clause; it is not checked and not enforced.`,
          }
        : c,
    ),
    revisionHistory: [
      ...pack.revisionHistory,
      `v${pack.packVersion} -> v${pack.packVersion + 1}: clause ${clauseId} excluded by revision. Reason: ${reason}`,
    ],
  };
}

/** Rebind an existing pack to a new batch. This is the template-reuse path. */
export function rebindToSource(pack: AcceptancePack, source: readonly RecordRow[], title: string): AcceptancePack {
  const clauses = pack.clauses.map((c) =>
    c.ruleId === 1 ? { ...c, text: `The result contains exactly ${source.length} rows.` } : c,
  );
  return {
    ...pack,
    title,
    packVersion: 1,
    clauses,
    sourceDigest: canonicalDigest(source),
    requiredRowCount: source.length,
    revisionHistory: pack.revisionHistory.length
      ? [...pack.revisionHistory, `rebound to a new source batch (${source.length} rows); revisions above are carried forward`]
      : [],
  };
}

/** Fixed key order. Any change here is a new pack format, not a silent digest change. */
const PACK_KEY_ORDER: (keyof AcceptancePack)[] = [
  "packFormat", "templateId", "templateVersion", "packVersion", "title",
  "checkerPolicyIdPreimage", "checkerPolicyId", "checkerPolicyVersion", "ruleMask",
  "sourceDigest", "requiredRowCount", "clauses", "payment", "revisionHistory",
];
const CLAUSE_KEY_ORDER: (keyof Clause)[] = ["id", "text", "coverage", "ruleId", "note"];
const PAYMENT_KEY_ORDER: (keyof PaymentPolicy)[] = [
  "tokenSymbol", "paymentToken", "tokenDecimals", "amountBaseUnits",
  "deliveryWindowSeconds", "settlementWindowSeconds",
];

export function canonicalPackJson(pack: AcceptancePack): string {
  const ordered: Record<string, unknown> = {};
  for (const k of PACK_KEY_ORDER) {
    if (k === "clauses") {
      ordered[k] = pack.clauses.map((c) => {
        const o: Record<string, unknown> = {};
        for (const ck of CLAUSE_KEY_ORDER) o[ck] = c[ck];
        return o;
      });
    } else if (k === "payment") {
      const o: Record<string, unknown> = {};
      for (const pk of PAYMENT_KEY_ORDER) o[pk] = pack.payment[pk];
      ordered[k] = o;
    } else {
      ordered[k] = pack[k];
    }
  }
  return JSON.stringify(ordered);
}

export function packDigest(pack: AcceptancePack): string {
  return keccak256(toUtf8Bytes(canonicalPackJson(pack)));
}
