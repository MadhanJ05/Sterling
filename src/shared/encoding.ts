/**
 * Canonical encoding and commitments. This file is the TypeScript side of the cross-language
 * parity tests; the Solidity side is contracts/Types.sol + CatalogueNormalizationPolicyV1.
 * Spec: docs/encoding.md (frozen v1).
 */
import { AbiCoder, keccak256, solidityPackedKeccak256, toUtf8Bytes } from "ethers";
import {
  ENCODING_VERSION,
  MAX_RECORDS,
  POLICY_ID_PREIMAGE,
  UINT32_MAX,
  UINT64_MAX,
  type RecordRow,
} from "./types.ts";

const coder = AbiCoder.defaultAbiCoder();

export const RECORD_ARRAY_TYPE = "tuple(uint32 productId,uint64 priceCents)[]";

export class EncodingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "EncodingError";
  }
}

function assertRange(rows: readonly RecordRow[]) {
  if (rows.length > MAX_RECORDS) {
    throw new EncodingError("TOO_MANY_RECORDS", `at most ${MAX_RECORDS} records, received ${rows.length}`);
  }
  rows.forEach((r, i) => {
    if (r.productId < 0n || r.productId > UINT32_MAX) {
      throw new EncodingError("ID_OUT_OF_RANGE", `row ${i}: productId ${r.productId} outside uint32`);
    }
    if (r.priceCents < 0n || r.priceCents > UINT64_MAX) {
      throw new EncodingError("PRICE_OUT_OF_RANGE", `row ${i}: priceCents ${r.priceCents} outside uint64`);
    }
  });
}

/** abi.encode(uint16 ENCODING_VERSION, Record[] records). Standard encoding, never packed. */
export function canonicalBundleBytes(rows: readonly RecordRow[]): string {
  assertRange(rows);
  return coder.encode(
    ["uint16", RECORD_ARRAY_TYPE],
    [ENCODING_VERSION, rows.map((r) => [r.productId, r.priceCents])],
  );
}

export function canonicalDigest(rows: readonly RecordRow[]): string {
  return keccak256(canonicalBundleBytes(rows));
}

/** Inverse of canonicalBundleBytes. Throws if the version tag is not 1. */
export function decodeCanonicalBundle(bytes: string): RecordRow[] {
  const [version, rows] = coder.decode(["uint16", RECORD_ARRAY_TYPE], bytes);
  if (Number(version) !== ENCODING_VERSION) {
    throw new EncodingError("BAD_ENCODING_VERSION", `expected encoding version ${ENCODING_VERSION}, got ${version}`);
  }
  return rows.map((r: any) => ({ productId: BigInt(r[0]), priceCents: BigInt(r[1]) }));
}

export const POLICY_ID = solidityPackedKeccak256(["string"], [POLICY_ID_PREIMAGE]);

export const TERMS_TYPEHASH = keccak256(
  toUtf8Bytes(
    "AcceptanceTermsV1(uint256 chainId,address escrow,uint256 jobId,address buyer,address provider,address paymentToken,uint256 amount,bytes32 sourceDigest,uint16 requiredRowCount,bytes32 policyId,uint16 policyVersion,uint8 ruleMask,bytes32 packDigest,uint64 deliveryDeadline,uint64 settlementExpiry)",
  ),
);

export interface TermsForDigest {
  chainId: bigint;
  escrow: string;
  jobId: bigint;
  buyer: string;
  provider: string;
  paymentToken: string;
  amount: bigint;
  sourceDigest: string;
  requiredRowCount: number;
  policyId: string;
  policyVersion: number;
  ruleMask: number;
  packDigest: string;
  deliveryDeadline: bigint;
  settlementExpiry: bigint;
}

/**
 * Single 16-argument abi.encode. The contract splits this into two halves to stay inside the
 * EVM stack limit; because every field is a static type the bytes are identical, and
 * tests/terms-digest.test.ts asserts that against the deployed contract.
 */
export function termsDigest(t: TermsForDigest): string {
  return keccak256(
    coder.encode(
      [
        "bytes32", "uint256", "address", "uint256", "address", "address", "address", "uint256",
        "bytes32", "uint16", "bytes32", "uint16", "uint8", "bytes32", "uint64", "uint64",
      ],
      [
        TERMS_TYPEHASH, t.chainId, t.escrow, t.jobId, t.buyer, t.provider, t.paymentToken, t.amount,
        t.sourceDigest, t.requiredRowCount, t.policyId, t.policyVersion, t.ruleMask, t.packDigest,
        t.deliveryDeadline, t.settlementExpiry,
      ],
    ),
  );
}

/** Display helper for token base units. Pure integer arithmetic; no floating point. */
export function formatTokenAmount(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const neg = baseUnits < 0n;
  const v = neg ? -baseUnits : baseUnits;
  const whole = (v / scale).toString();
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Display helper. Money is integer cents everywhere; this only formats for humans. */
export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? "-" : ""}${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}
