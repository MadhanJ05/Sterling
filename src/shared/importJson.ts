/**
 * Strict JSON import boundary. Nothing is ever coerced, rounded or silently dropped: an input
 * that cannot be represented exactly is rejected with a named code and a row index.
 * Spec: docs/encoding.md section 5.
 */
import { JSON_SAFE_MAX, MAX_RECORDS, UINT32_MAX, type RecordRow } from "./types.ts";

export interface ImportIssue {
  code: string;
  message: string;
  rowIndex?: number;
  field?: string;
}

export type ImportResult =
  | { ok: true; rows: RecordRow[] }
  | { ok: false; issues: ImportIssue[] };

const ALLOWED_KEYS = new Set(["productId", "priceCents"]);

/** Detects duplicate keys, which JSON.parse resolves silently by last-wins. */
function findDuplicateKeys(text: string): string | null {
  // Objects in this schema are flat and small, so a scan of object bodies is sufficient.
  const objectBodies = text.match(/\{[^{}]*\}/g) ?? [];
  for (const body of objectBodies) {
    const keys = [...body.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]!);
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) return k;
      seen.add(k);
    }
  }
  return null;
}

export function importRecordsFromJson(text: string, opts: { maxRecords?: number } = {}): ImportResult {
  const maxRecords = opts.maxRecords ?? MAX_RECORDS;
  const issues: ImportIssue[] = [];

  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, issues: [{ code: "EMPTY_INPUT", message: "No input provided." }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [{ code: "MALFORMED_JSON", message: `Input is not valid JSON: ${(e as Error).message}` }],
    };
  }

  const dupKey = findDuplicateKeys(text);
  if (dupKey) {
    return {
      ok: false,
      issues: [{
        code: "DUPLICATE_KEY",
        message: `Key "${dupKey}" appears more than once in one object. JSON.parse would silently keep the last value; refusing to guess.`,
      }],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [{ code: "ROOT_NOT_ARRAY", message: "Expected a JSON array of {productId, priceCents} objects." }],
    };
  }

  if (parsed.length === 0) {
    issues.push({ code: "EMPTY_ARRAY", message: "The array contains no rows." });
  }
  if (parsed.length > maxRecords) {
    issues.push({
      code: "TOO_MANY_ROWS",
      message: `At most ${maxRecords} rows are supported in version 1; received ${parsed.length}.`,
    });
  }

  const rows: RecordRow[] = [];
  parsed.slice(0, Math.min(parsed.length, maxRecords)).forEach((raw, rowIndex) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({ code: "ROW_NOT_OBJECT", message: "Row must be a JSON object.", rowIndex });
      return;
    }
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_KEYS.has(key)) {
        issues.push({
          code: "UNKNOWN_FIELD",
          message: `Unsupported field "${key}". Version 1 accepts only productId and priceCents. Nothing is dropped silently, so this import is rejected.`,
          rowIndex,
          field: key,
        });
      }
    }
    const productId = readUint(obj, "productId", rowIndex, UINT32_MAX, issues, "ID");
    const priceCents = readUint(obj, "priceCents", rowIndex, JSON_SAFE_MAX, issues, "PRICE");
    if (productId !== null && priceCents !== null) rows.push({ productId, priceCents });
  });

  if (issues.length) return { ok: false, issues };
  return { ok: true, rows };
}

function readUint(
  obj: Record<string, unknown>,
  field: string,
  rowIndex: number,
  max: bigint,
  issues: ImportIssue[],
  prefix: string,
): bigint | null {
  if (!(field in obj)) {
    issues.push({ code: `${prefix}_MISSING`, message: `Missing required field "${field}".`, rowIndex, field });
    return null;
  }
  const v = obj[field];
  if (typeof v !== "number") {
    issues.push({
      code: `${prefix}_NOT_NUMBER`,
      message: `"${field}" must be a JSON number, received ${v === null ? "null" : typeof v}. Strings are not coerced.`,
      rowIndex,
      field,
    });
    return null;
  }
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    issues.push({
      code: `${prefix}_NOT_INTEGER`,
      message: `"${field}" must be a whole number, received ${v}. Money is integer cents; fractions are never rounded.`,
      rowIndex,
      field,
    });
    return null;
  }
  if (!Number.isSafeInteger(v)) {
    issues.push({
      code: `${prefix}_NOT_SAFE_INTEGER`,
      message: `"${field}" is ${v}, above JavaScript's exact-integer limit (${JSON_SAFE_MAX}). JSON parsing would lose precision, so this is rejected rather than rounded.`,
      rowIndex,
      field,
    });
    return null;
  }
  const b = BigInt(v);
  if (b < 0n || b > max) {
    issues.push({
      code: `${prefix}_OUT_OF_RANGE`,
      message: `"${field}" is ${v}, outside the documented range 0..${max}.`,
      rowIndex,
      field,
    });
    return null;
  }
  return b;
}

/**
 * Export format. Round-trips exactly through importRecordsFromJson. Throws rather than emit a
 * lossy number: values above the JSON safe-integer limit are representable on-chain but not in
 * this interchange format (docs/encoding.md section 5).
 */
export function exportRecordsToJson(rows: readonly RecordRow[]): string {
  return JSON.stringify(
    rows.map((r, i) => {
      if (r.productId > JSON_SAFE_MAX || r.priceCents > JSON_SAFE_MAX) {
        throw new Error(
          `Row ${i} holds a value above the JSON safe-integer limit and cannot be exported as JSON without losing precision.`,
        );
      }
      return { productId: Number(r.productId), priceCents: Number(r.priceCents) };
    }),
    null,
    2,
  );
}
