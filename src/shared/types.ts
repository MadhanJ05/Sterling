/** Mirrors contracts/Types.sol. See docs/encoding.md (frozen v1). */

export interface RecordRow {
  productId: bigint;
  priceCents: bigint;
}

export const ENCODING_VERSION = 1;
export const MAX_RECORDS = 32;

export const UINT32_MAX = 4294967295n;
export const UINT64_MAX = 18446744073709551615n;
/** Number.MAX_SAFE_INTEGER. The JSON import boundary is narrower than the encoder on purpose. */
export const JSON_SAFE_MAX = 9007199254740991n;

export const Verdict = { INDETERMINATE: 0, PASS: 1, FAIL: 2 } as const;
export type VerdictCode = 0 | 1 | 2;

export const FailCode = {
  NONE: 0,
  ROW_COUNT_MISMATCH: 1,
  MISSING_SOURCE_ID: 2,
  DUPLICATE_SOURCE_ID: 3,
  UNKNOWN_ID: 4,
  PRICE_MISMATCH: 5,
  ORDER_VIOLATION: 6,
  UNSUPPORTED_RULE_MASK: 100,
  SOURCE_OUT_OF_BOUNDS: 101,
  OUTPUT_OUT_OF_BOUNDS: 102,
  ROW_COUNT_INCONSISTENT: 103,
  POLICY_CALL_FAILED: 104,
} as const;

export const JobStatus = [
  "NONE",
  "CREATED",
  "ACCEPTED",
  "FUNDED",
  "SUBMITTED",
  "PAID",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type JobStatusName = (typeof JobStatus)[number];

export const POLICY_ID_PREIMAGE = "acceptance-mvp/catalogue-normalization/v1";
export const POLICY_VERSION = 1;
export const ALL_RULES = 0x0f;

export interface RuleDescriptor {
  id: 1 | 2 | 3 | 4;
  key: string;
  plain: string;
  technical: string;
}

/** The four frozen rules, in the frozen evaluation order. */
export const RULES: readonly RuleDescriptor[] = [
  {
    id: 1,
    key: "ROW_COUNT",
    plain: "The result has exactly the agreed number of rows.",
    technical: "output.length === requiredRowCount",
  },
  {
    id: 2,
    key: "IDENTITY",
    plain: "Every product from the agreed source appears exactly once, and nothing else appears.",
    technical: "output ids form a permutation of source ids",
  },
  {
    id: 3,
    key: "PRICE",
    plain: "Each price is unchanged from the agreed source.",
    technical: "output[j].priceCents === source[match].priceCents",
  },
  {
    id: 4,
    key: "ORDER",
    plain: "Products are sorted by product ID, lowest first, with no ties.",
    technical: "output[j].productId > output[j-1].productId",
  },
];

export function ruleById(id: number): RuleDescriptor | undefined {
  return RULES.find((r) => r.id === id);
}
