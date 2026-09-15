/**
 * TypeScript mirror of contracts/CatalogueNormalizationPolicyV1.sol.
 *
 * This checker produces readable, rule-level findings. It has no settlement authority: the
 * contract calls its own immutable policy contract and ignores anything computed here. The two
 * implementations are held together by tests/checker-parity.test.ts, which compares them on
 * generated batches without consulting either one's expected-result function.
 */
import {
  ALL_RULES,
  FailCode,
  MAX_RECORDS,
  RULES,
  Verdict,
  ruleById,
  type RecordRow,
  type VerdictCode,
} from "./types.ts";
import { formatCents } from "./encoding.ts";

export interface PolicyResult {
  verdict: VerdictCode;
  verdictName: "INDETERMINATE" | "PASS" | "FAIL";
  ruleId: number;
  failCode: number;
  detailA: bigint;
  detailB: bigint;
}

export interface RuleFinding {
  ruleId: number;
  key: string;
  plain: string;
  technical: string;
  status: "PASS" | "FAIL" | "NOT_REACHED" | "INDETERMINATE";
  detail: string;
}

export interface CheckReport {
  result: PolicyResult;
  headline: string;
  findings: RuleFinding[];
}

const pass = (): PolicyResult => ({
  verdict: Verdict.PASS, verdictName: "PASS", ruleId: 0, failCode: FailCode.NONE, detailA: 0n, detailB: 0n,
});
const fail = (ruleId: number, failCode: number, detailA: bigint, detailB: bigint): PolicyResult => ({
  verdict: Verdict.FAIL, verdictName: "FAIL", ruleId, failCode, detailA, detailB,
});
const ind = (failCode: number, detailA: bigint, detailB: bigint): PolicyResult => ({
  verdict: Verdict.INDETERMINATE, verdictName: "INDETERMINATE", ruleId: 0, failCode, detailA, detailB,
});

/**
 * Evaluation order is frozen: rule 1, then rule 2 (unknown ids first, then missing/duplicate in
 * ascending source order), then rule 3, then rule 4. The first violation found is the reported
 * one. This mirrors the contract exactly, including the ordering.
 */
export function evaluate(
  source: readonly RecordRow[],
  output: readonly RecordRow[],
  requiredRowCount: number,
  ruleMask: number = ALL_RULES,
): PolicyResult {
  if (ruleMask !== ALL_RULES) return ind(FailCode.UNSUPPORTED_RULE_MASK, 0n, 0n);
  if (source.length === 0 || source.length > MAX_RECORDS) {
    return ind(FailCode.SOURCE_OUT_OF_BOUNDS, BigInt(source.length), 0n);
  }
  if (output.length > MAX_RECORDS) return ind(FailCode.OUTPUT_OUT_OF_BOUNDS, BigInt(output.length), 0n);
  if (requiredRowCount !== source.length) {
    return ind(FailCode.ROW_COUNT_INCONSISTENT, BigInt(requiredRowCount), BigInt(source.length));
  }

  // Rule 1
  if (output.length !== requiredRowCount) {
    return fail(1, FailCode.ROW_COUNT_MISMATCH, BigInt(output.length), BigInt(requiredRowCount));
  }

  // Rule 2a: nothing outside the approved source
  for (let j = 0; j < output.length; j++) {
    const row = output[j]!;
    if (!source.some((s) => s.productId === row.productId)) {
      return fail(2, FailCode.UNKNOWN_ID, row.productId, BigInt(j));
    }
  }
  // Rule 2b: every source id exactly once, in source order
  for (const s of source) {
    const occurrences = output.reduce((n, o) => (o.productId === s.productId ? n + 1 : n), 0);
    if (occurrences === 0) return fail(2, FailCode.MISSING_SOURCE_ID, s.productId, 0n);
    if (occurrences > 1) return fail(2, FailCode.DUPLICATE_SOURCE_ID, s.productId, BigInt(occurrences));
  }

  // Rule 3
  for (const o of output) {
    const s = source.find((x) => x.productId === o.productId)!;
    if (s.priceCents !== o.priceCents) return fail(3, FailCode.PRICE_MISMATCH, o.productId, s.priceCents);
  }

  // Rule 4
  for (let j = 1; j < output.length; j++) {
    const cur = output[j]!;
    const prev = output[j - 1]!;
    if (cur.productId <= prev.productId) {
      return fail(4, FailCode.ORDER_VIOLATION, cur.productId, prev.productId);
    }
  }

  return pass();
}

export function describe(result: PolicyResult, submitted: readonly RecordRow[] = []): CheckReport {
  const findings: RuleFinding[] = RULES.map((r) => {
    if (result.verdict === Verdict.INDETERMINATE) {
      return { ruleId: r.id, key: r.key, plain: r.plain, technical: r.technical, status: "INDETERMINATE" as const, detail: "Not evaluated." };
    }
    if (result.verdict === Verdict.PASS) {
      return { ruleId: r.id, key: r.key, plain: r.plain, technical: r.technical, status: "PASS" as const, detail: "Satisfied." };
    }
    if (r.id < result.ruleId) {
      return { ruleId: r.id, key: r.key, plain: r.plain, technical: r.technical, status: "PASS" as const, detail: "Satisfied." };
    }
    if (r.id === result.ruleId) {
      return { ruleId: r.id, key: r.key, plain: r.plain, technical: r.technical, status: "FAIL" as const, detail: explain(result, submitted) };
    }
    return {
      ruleId: r.id, key: r.key, plain: r.plain, technical: r.technical, status: "NOT_REACHED" as const,
      detail: `Not evaluated: checking stopped at rule ${result.ruleId}.`,
    };
  });

  return { result, findings, headline: headline(result, submitted) };
}

function headline(result: PolicyResult, submitted: readonly RecordRow[]): string {
  if (result.verdict === Verdict.PASS) return "All four rules are satisfied. The delivery meets the agreed definition of done.";
  if (result.verdict === Verdict.INDETERMINATE) {
    return `The check could not be completed (${indReason(result.failCode)}). No pass or fail is claimed.`;
  }
  const rule = ruleById(result.ruleId);
  return `Rule ${result.ruleId} (${rule?.key ?? "?"}) is not satisfied: ${explain(result, submitted)}`;
}

function indReason(code: number): string {
  switch (code) {
    case FailCode.UNSUPPORTED_RULE_MASK: return "the job asks for a rule set this policy version does not implement";
    case FailCode.SOURCE_OUT_OF_BOUNDS: return "the approved source is empty or larger than the supported bound";
    case FailCode.OUTPUT_OUT_OF_BOUNDS: return "the delivery is larger than the supported bound";
    case FailCode.ROW_COUNT_INCONSISTENT: return "the agreed row count does not match the approved source";
    case FailCode.POLICY_CALL_FAILED: return "the policy contract could not complete evaluation";
    default: return `code ${code}`;
  }
}

function explain(result: PolicyResult, submitted: readonly RecordRow[]): string {
  const { failCode, detailA, detailB } = result;
  switch (failCode) {
    case FailCode.ROW_COUNT_MISMATCH:
      return `the delivery has ${detailA} rows; the agreed count is ${detailB}.`;
    case FailCode.MISSING_SOURCE_ID:
      return `product ${detailA} is in the approved source but not in the delivery.`;
    case FailCode.DUPLICATE_SOURCE_ID:
      return `product ${detailA} appears ${detailB} times in the delivery; it must appear exactly once.`;
    case FailCode.UNKNOWN_ID:
      return `product ${detailA} (delivery row ${detailB}) is not in the approved source.`;
    case FailCode.PRICE_MISMATCH: {
      const got = submitted.find((r) => r.productId === detailA);
      const gotTxt = got ? ` but the delivery says ${formatCents(got.priceCents)}` : "";
      return `product ${detailA} has approved price ${formatCents(detailB)}${gotTxt}.`;
    }
    case FailCode.ORDER_VIOLATION:
      return `product ${detailA} appears after product ${detailB}; IDs must strictly increase.`;
    default:
      return `fail code ${failCode}.`;
  }
}

export function check(
  source: readonly RecordRow[],
  output: readonly RecordRow[],
  requiredRowCount: number,
  ruleMask: number = ALL_RULES,
): CheckReport {
  return describe(evaluate(source, output, requiredRowCount, ruleMask), output);
}
