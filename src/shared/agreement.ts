/**
 * The strict agreement validator.
 *
 * The independent review of 14 September 2026 found the real gap in this project: every party
 * checked that fingerprints matched, and nobody checked that the things being fingerprinted
 * agreed with each other. A provider would happily accept a pack advertising 25 test dollars for
 * a job worth 1, or a pack naming a source batch the contract had never seen, because each
 * commitment was individually well formed.
 *
 * This module is the one place that answers "do all of these actually describe the same job?".
 * It runs before creation, before provider acceptance, before funding, and inside evidence
 * verification. It is deliberately a single implementation used by all four, so the four cannot
 * drift apart.
 *
 * What it cannot do, and never claims to: decide whether a sentence of English has been
 * adequately captured by a check. It can prove that an EXECUTABLE clause's text is exactly the
 * template text for the rule it names, which is a real and checkable property. It cannot prove
 * that arbitrary prose means what someone says it means, and a count or a label is not evidence.
 */
import { getAddress, isAddress } from "ethers";
import {
  ALL_RULES, MAX_RECORDS, POLICY_ID_PREIMAGE, POLICY_VERSION, type RecordRow,
} from "./types.ts";
import { POLICY_ID, canonicalDigest, type TermsForDigest } from "./encoding.ts";
import { termsDigest } from "./encoding.ts";
import {
  PACK_FORMAT, TEMPLATE_ID, TEMPLATE_VERSION, coverage, packDigest, templateClauses,
  type AcceptancePack, type Coverage,
} from "./pack.ts";

/** Mirrors AcceptanceEscrow's constants. A pack outside these cannot be created on chain. */
export const MIN_DELIVERY_WINDOW = 5;
export const MIN_SETTLEMENT_WINDOW = 10;

const VALID_COVERAGE: ReadonlySet<Coverage> = new Set<Coverage>([
  "EXECUTABLE", "EXTERNAL_ASSERTION", "JUDGEMENT", "EXCLUDED_BY_REVISION",
]);

export interface AgreementIssue {
  code: string;
  message: string;
}

export interface AgreementReport {
  ok: boolean;
  issues: AgreementIssue[];
  /** One line per issue, prefixed with its code, for logs and process output. */
  summary: string;
}

export interface AgreementExpectations {
  /** The caller's own address, checked against the role it believes it holds. */
  role?: "buyer" | "provider";
  address?: string;
  /** The escrow's immutable approved payment token, read from chain. */
  approvedPaymentToken?: string;
  /**
   * The approved token's own `decimals()`, read from chain. A pack that misstates precision
   * describes a different sum of money in human terms while matching base-unit-for-base-unit,
   * so this is checked against the asset rather than against another field in the same document.
   */
  approvedTokenDecimals?: number;
  chainId?: bigint;
  escrow?: string;
}

export interface AgreementInput {
  pack: AcceptancePack | null | undefined;
  /** Terms exactly as the contract stored them. */
  terms: TermsForDigest;
  /** The digest the contract stored, so the caller's own encoder is checked against it. */
  storedTermsDigest: string;
  /** Job creation timestamp, needed to check the delivery window the pack promised. */
  createdAt: number;
  /** The source rows the contract stored, when available. */
  sourceRows?: readonly RecordRow[];
  expect?: AgreementExpectations;
}

function report(issues: AgreementIssue[]): AgreementReport {
  return {
    ok: issues.length === 0,
    issues,
    summary: issues.length
      ? issues.map((i) => `${i.code}: ${i.message}`).join("\n")
      : "agreement validated: pack, terms and stored data all describe the same job",
  };
}

const same = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Structural validation of a pack on its own, with no job to compare it against. Used by the
 * buyer before it creates anything, so a malformed pack never reaches the chain.
 */
export function validatePackStructure(pack: AcceptancePack | null | undefined): AgreementReport {
  const issues: AgreementIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });

  if (!pack || typeof pack !== "object") {
    add("PACK_MISSING", "No acceptance pack was supplied. An agreement is required; a job with no approved pack cannot be validated.");
    return report(issues);
  }

  if (pack.packFormat !== PACK_FORMAT) {
    add("PACK_FORMAT_UNSUPPORTED", `Unsupported pack format ${JSON.stringify(pack.packFormat)}; this build accepts only ${PACK_FORMAT}.`);
    return report(issues);
  }
  if (pack.templateId !== TEMPLATE_ID || pack.templateVersion !== TEMPLATE_VERSION) {
    add("PACK_TEMPLATE_UNSUPPORTED", `Unsupported template ${pack.templateId}/v${pack.templateVersion}; this build implements only ${TEMPLATE_ID}/v${TEMPLATE_VERSION}.`);
  }
  if (pack.checkerPolicyIdPreimage !== POLICY_ID_PREIMAGE || pack.checkerPolicyId !== POLICY_ID) {
    add("PACK_POLICY_MISMATCH", `The pack names checker ${pack.checkerPolicyIdPreimage}, which is not the policy this build implements (${POLICY_ID_PREIMAGE}).`);
  }
  if (pack.checkerPolicyVersion !== POLICY_VERSION) {
    add("PACK_POLICY_MISMATCH", `The pack names checker version ${pack.checkerPolicyVersion}; this build implements version ${POLICY_VERSION}.`);
  }
  if (pack.ruleMask !== ALL_RULES) {
    add("PACK_RULE_MASK_UNSUPPORTED", `Rule mask 0x${Number(pack.ruleMask).toString(16)} is not supported; version 1 requires all four rules (0x0f).`);
  }
  if (!Number.isInteger(pack.requiredRowCount) || pack.requiredRowCount < 1 || pack.requiredRowCount > MAX_RECORDS) {
    add("PACK_ROW_COUNT_OUT_OF_RANGE", `requiredRowCount ${pack.requiredRowCount} is outside the supported range 1..${MAX_RECORDS}.`);
  }
  if (typeof pack.sourceDigest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pack.sourceDigest)) {
    add("PACK_SOURCE_DIGEST_INVALID", "The pack's sourceDigest is not a 32-byte hex digest.");
  }

  // ---- clauses -------------------------------------------------------------
  if (!Array.isArray(pack.clauses) || pack.clauses.length === 0) {
    add("CLAUSES_MISSING", "The pack lists no clauses.");
  } else {
    const canonical = templateClauses(pack.requiredRowCount);
    const seenRules = new Map<number, string>();
    for (const c of pack.clauses) {
      if (!c || typeof c.id !== "string" || typeof c.text !== "string") {
        add("CLAUSE_MALFORMED", "A clause is missing its id or text.");
        continue;
      }
      if (!VALID_COVERAGE.has(c.coverage)) {
        add("CLAUSE_COVERAGE_INVALID", `Clause ${c.id} has coverage ${JSON.stringify(c.coverage)}, which is not a recognised classification.`);
        continue;
      }
      if (c.coverage === "EXECUTABLE") {
        if (typeof c.ruleId !== "number" || !canonical.some((t) => t.ruleId === c.ruleId)) {
          add("CLAUSE_RULE_ID_INVALID", `Clause ${c.id} is labelled EXECUTABLE but names rule ${c.ruleId}, which this policy does not implement.`);
          continue;
        }
        if (seenRules.has(c.ruleId)) {
          add("CLAUSE_RULE_DUPLICATED", `Rule ${c.ruleId} is claimed by both clause ${seenRules.get(c.ruleId)} and clause ${c.id}.`);
          continue;
        }
        seenRules.set(c.ruleId, c.id);
        const expected = canonical.find((t) => t.ruleId === c.ruleId)!;
        if (c.text !== expected.text) {
          add(
            "CLAUSE_TEXT_NOT_FROM_TEMPLATE",
            `Clause ${c.id} is labelled EXECUTABLE for rule ${c.ruleId}, but its text is not the template text for that rule. ` +
            `A label does not create a check. Expected: ${JSON.stringify(expected.text)}. Found: ${JSON.stringify(c.text)}.`,
          );
        }
      } else if (c.ruleId !== null && c.ruleId !== undefined) {
        add("CLAUSE_NON_EXECUTABLE_HAS_RULE_ID", `Clause ${c.id} is ${c.coverage} but names rule ${c.ruleId}. A clause software cannot check cannot claim a rule.`);
      }
    }
    for (const t of canonical) {
      if (!seenRules.has(t.ruleId!)) {
        add("CLAUSE_RULE_MISSING", `No clause covers rule ${t.ruleId}. All four rules are enforced on chain, so all four must be stated in the agreement.`);
      }
    }
  }

  const cov = coverage(pack);
  if (!cov.fullyAutomatic) {
    add(
      "PACK_NOT_FULLY_AUTOMATIC",
      `${cov.unsupportedClauseCount} clause(s) in this pack cannot be checked by software ` +
      `(${cov.judgement} requiring judgement, ${cov.externalAssertion} depending on an external assertion). ` +
      `This pack must not enter the automatic flow. The only route forward is an explicit scope revision.`,
    );
  }

  // ---- payment policy ------------------------------------------------------
  const pay = pack.payment;
  if (!pay || typeof pay !== "object") {
    add("PAYMENT_POLICY_MISSING", "The pack has no payment policy.");
  } else {
    if (typeof pay.paymentToken !== "string" || !isAddress(pay.paymentToken)) {
      add("PAYMENT_TOKEN_INVALID", `The pack's paymentToken ${JSON.stringify(pay.paymentToken)} is not an address. A token symbol does not identify a payment asset.`);
    }
    if (!/^[0-9]+$/.test(String(pay.amountBaseUnits)) || BigInt(pay.amountBaseUnits) <= 0n) {
      add("PAYMENT_AMOUNT_INVALID", `The pack's amountBaseUnits ${JSON.stringify(pay.amountBaseUnits)} is not a positive integer in base units.`);
    }
    if (!Number.isInteger(pay.tokenDecimals) || pay.tokenDecimals < 0 || pay.tokenDecimals > 36) {
      add("PAYMENT_DECIMALS_INVALID", `Token decimals ${pay.tokenDecimals} is not plausible.`);
    }
    if (!Number.isInteger(pay.deliveryWindowSeconds) || pay.deliveryWindowSeconds < MIN_DELIVERY_WINDOW) {
      add("WINDOW_INVALID", `Delivery window ${pay.deliveryWindowSeconds}s is below the contract minimum of ${MIN_DELIVERY_WINDOW}s.`);
    }
    if (!Number.isInteger(pay.settlementWindowSeconds) || pay.settlementWindowSeconds < MIN_SETTLEMENT_WINDOW) {
      add("WINDOW_INVALID", `Settlement window ${pay.settlementWindowSeconds}s is below the contract minimum of ${MIN_SETTLEMENT_WINDOW}s.`);
    }
  }

  return report(issues);
}

/**
 * Full validation: the pack, the terms the contract stored, the stored source rows, and the
 * caller's own expectations, all checked against each other.
 */
export function validateAgreement(input: AgreementInput): AgreementReport {
  const structural = validatePackStructure(input.pack);
  const issues = [...structural.issues];
  const add = (code: string, message: string) => issues.push({ code, message });
  const pack = input.pack;
  const t = input.terms;

  // A structurally broken pack cannot be meaningfully compared to anything.
  if (!pack || pack.packFormat !== PACK_FORMAT) return report(issues);

  // ---- the caller's own encoder must agree with the contract ---------------
  const recomputed = termsDigest(t);
  if (recomputed !== input.storedTermsDigest) {
    add("TERMS_DIGEST_MISMATCH", `Recomputing the terms gives ${recomputed}, but the contract stored ${input.storedTermsDigest}.`);
  }

  // ---- pack vs terms -------------------------------------------------------
  const pd = packDigest(pack);
  if (pd !== t.packDigest) {
    add("PACK_DIGEST_MISMATCH", `The pack shown hashes to ${pd}, but the job is bound to ${t.packDigest}. This is not the agreement the contract holds.`);
  }
  if (pack.sourceDigest !== t.sourceDigest) {
    add("PACK_SOURCE_DIGEST_MISMATCH", `The pack names source batch ${pack.sourceDigest}, but the job's approved source is ${t.sourceDigest}. The agreement describes different data from the job.`);
  }
  if (pack.requiredRowCount !== t.requiredRowCount) {
    add("ROW_COUNT_MISMATCH", `The pack requires ${pack.requiredRowCount} rows; the job requires ${t.requiredRowCount}.`);
  }
  if (pack.ruleMask !== t.ruleMask) {
    add("RULE_MASK_MISMATCH", `The pack's rule mask 0x${pack.ruleMask.toString(16)} differs from the job's 0x${t.ruleMask.toString(16)}.`);
  }
  if (pack.checkerPolicyId !== t.policyId || pack.checkerPolicyVersion !== t.policyVersion) {
    add("POLICY_MISMATCH", `The pack names checker ${pack.checkerPolicyId} v${pack.checkerPolicyVersion}; the job is bound to ${t.policyId} v${t.policyVersion}.`);
  }
  if (pack.payment && BigInt(pack.payment.amountBaseUnits || "0") !== t.amount) {
    add("AMOUNT_MISMATCH", `The pack advertises ${pack.payment.amountBaseUnits} base units; the job's escrowed amount is ${t.amount}. The agreement is about a different sum of money.`);
  }
  if (pack.payment?.paymentToken && !same(pack.payment.paymentToken, t.paymentToken)) {
    add("PAYMENT_TOKEN_MISMATCH", `The pack names payment token ${pack.payment.paymentToken}; the job uses ${t.paymentToken}.`);
  }

  // ---- deadline policy -----------------------------------------------------
  if (pack.payment && Number.isFinite(input.createdAt) && input.createdAt > 0) {
    const deliveryWindow = Number(t.deliveryDeadline) - input.createdAt;
    const settlementWindow = Number(t.settlementExpiry) - Number(t.deliveryDeadline);
    if (deliveryWindow !== pack.payment.deliveryWindowSeconds) {
      add("DELIVERY_WINDOW_MISMATCH", `The pack promises ${pack.payment.deliveryWindowSeconds}s to deliver; the job allows ${deliveryWindow}s.`);
    }
    if (settlementWindow !== pack.payment.settlementWindowSeconds) {
      add("SETTLEMENT_WINDOW_MISMATCH", `The pack promises ${pack.payment.settlementWindowSeconds}s to settle; the job allows ${settlementWindow}s.`);
    }
  }
  if (Number(t.settlementExpiry) <= Number(t.deliveryDeadline)) {
    add("EXPIRY_ORDER_INVALID", "Settlement expiry does not follow the delivery deadline.");
  }

  // ---- stored source rows --------------------------------------------------
  if (input.sourceRows) {
    if (input.sourceRows.length !== t.requiredRowCount) {
      add("SOURCE_ROWS_INVALID", `The contract stored ${input.sourceRows.length} source rows against a required ${t.requiredRowCount}.`);
    } else {
      const ids = new Set(input.sourceRows.map((r) => r.productId));
      if (ids.size !== input.sourceRows.length) add("SOURCE_ROWS_INVALID", "The stored source contains duplicate product IDs.");
      const d = canonicalDigest(input.sourceRows);
      if (d !== t.sourceDigest) {
        add("SOURCE_DIGEST_MISMATCH", `The stored source rows hash to ${d}, not the committed ${t.sourceDigest}.`);
      }
    }
  }

  // ---- the caller's expectations -------------------------------------------
  const e = input.expect;
  if (e) {
    if (e.role === "provider" && e.address && !same(e.address, t.provider)) {
      add("PARTY_MISMATCH", `This job names provider ${t.provider}, which is not this agent (${e.address}).`);
    }
    if (e.role === "buyer" && e.address && !same(e.address, t.buyer)) {
      add("PARTY_MISMATCH", `This job names buyer ${t.buyer}, which is not this agent (${e.address}).`);
    }
    if (e.approvedPaymentToken && !same(e.approvedPaymentToken, t.paymentToken)) {
      add("APPROVED_TOKEN_MISMATCH", `The job pays in ${t.paymentToken}, but the escrow's approved token is ${e.approvedPaymentToken}.`);
    }
    if (e.approvedTokenDecimals !== undefined && pack.payment?.tokenDecimals !== e.approvedTokenDecimals) {
      add(
        "PAYMENT_DECIMALS_MISMATCH",
        `The pack says the payment token has ${pack.payment?.tokenDecimals} decimals, but ${t.paymentToken} ` +
        `reports ${e.approvedTokenDecimals}. The base-unit amount would be unchanged, but the agreement ` +
        `would describe a different sum of money to a human reader.`,
      );
    }
    if (e.chainId !== undefined && e.chainId !== t.chainId) {
      add("CHAIN_MISMATCH", `These terms are bound to chain ${t.chainId}, not ${e.chainId}.`);
    }
    if (e.escrow && !same(e.escrow, t.escrow)) {
      add("ESCROW_MISMATCH", `These terms are bound to escrow ${t.escrow}, not ${e.escrow}.`);
    }
  }
  if (same(t.buyer, t.provider)) add("PARTY_MISMATCH", "Buyer and provider are the same account.");

  return report(issues);
}

/** Convenience for callers that want to fail loudly. */
export class AgreementRejected extends Error {
  constructor(readonly report: AgreementReport) {
    super(`Agreement rejected:\n${report.summary}`);
    this.name = "AgreementRejected";
  }
}

export function assertAgreement(input: AgreementInput): AgreementReport {
  const r = validateAgreement(input);
  if (!r.ok) throw new AgreementRejected(r);
  return r;
}

export { getAddress };
