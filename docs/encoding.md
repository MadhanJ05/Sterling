# Canonical encoding, commitments, and terms digest — version 1 (FROZEN)

Frozen 14 September 2026, before any consumer of it was implemented. Any change to this
document is a new encoding version and a new policy version; it cannot alter an existing job.

## 0. What is and is not committed

The settlement commitment covers the **canonical typed data bundle** defined below — a version
tag and an ordered array of `(productId, priceCents)` records.

It does **not** cover an uploaded JSON file byte-for-byte. Whitespace, key order, trailing
newlines and duplicate-key resolution in an uploaded file are *not* protected. A JSON file is
an import/preview/export format only.

If a raw upload hash is ever displayed, it is labelled "uploaded file hash (not the settlement
commitment)" and is never used by the contract.

## 1. Record type

```
struct Record {
    uint32 productId;    // range 0 .. 4294967295 inclusive
    uint64 priceCents;   // range 0 .. 18446744073709551615 inclusive
}
```

- `priceCents` is an integer number of cents. Floating point is never used for money anywhere
  in this project, in any layer, including display.
- `productId` has no reserved sentinel value. `0` is a legal product ID. Absence is represented
  by a separate boolean in the checker, never by a magic number.

## 2. Canonical bundle bytes

```
bundleBytes = abi.encode(uint16 ENCODING_VERSION, Record[] records)
ENCODING_VERSION = 1
```

This is **standard ABI encoding** (`abi.encode`), not `abi.encodePacked`. Standard encoding is
length-prefixed and 32-byte padded, so it is unambiguous: two different record arrays can never
produce the same bytes. Packed encoding is explicitly rejected for this reason.

Concretely the layout is:

| offset | 32-byte word | meaning |
|---|---|---|
| 0x00 | `0x...0001` | `ENCODING_VERSION` left-padded to 32 bytes |
| 0x20 | `0x...0040` | offset to the array data (always 0x40 for this 2-element tuple) |
| 0x40 | `n` | number of records |
| 0x60 | `records[0].productId` | left-padded to 32 bytes |
| 0x80 | `records[0].priceCents` | left-padded to 32 bytes |
| ... | | two words per record, in array order |

Total length is `0x60 + 64 * n` bytes. Array order is preserved and is part of the commitment:
the same records in a different order produce different bytes and a different digest.

In TypeScript this is
`AbiCoder.defaultAbiCoder().encode(["uint16","tuple(uint32 productId,uint64 priceCents)[]"], [1, records])`.

In Solidity it is `abi.encode(ENCODING_VERSION, records)` for `Record[] memory records`.

Cross-language golden vectors in `fixtures/golden-vectors.json` pin this, including the empty
array, a single record at both field minimums, a single record at both field maximums, and two
arrays that differ only in order. `tests/encoding-parity.test.ts` asserts that the TypeScript
encoder and the deployed Solidity contract produce identical bytes and identical digests for
every vector.

## 3. Digests

```
sourceDigest   = keccak256(bundleBytes(source records))
deliveryDigest = keccak256(bundleBytes(submitted output records))
```

The contract recomputes `deliveryDigest` itself from the typed rows it stored. A caller cannot
supply a digest, and cannot supply rows to the settlement function that differ from the rows the
provider submitted: `settle(jobId)` takes a job ID only and reads storage.

## 4. Bounds

| Bound | Value | Enforced where |
|---|---|---|
| Max source records | 32 | TypeScript import boundary and `AcceptanceEscrow.createJob` |
| Max output records | 32 | TypeScript import boundary and `AcceptanceEscrow.submitDelivery` |
| Min source records | 1 | `createJob` |
| Source `productId` uniqueness | required | `createJob` |
| Encoding version | must equal 1 | both |

Exceeding a bound is a bounded rejection at the import boundary or a revert. A revert of this
kind is **not** a verified failure of delivered work and is never displayed as one.

## 5. JSON import boundary (narrower than the encoding)

The encoder accepts the full `uint32`/`uint64` ranges. The JSON *importer* is deliberately
narrower, because `JSON.parse` silently loses precision above `Number.MAX_SAFE_INTEGER`:

- Every value must be a JSON number that is an exact integer and a JavaScript safe integer
  (`|v| <= 9007199254740991`). A number outside that range is rejected with
  `PRICE_NOT_SAFE_INTEGER` / `ID_NOT_SAFE_INTEGER` rather than silently rounded.
- Fractional numbers, strings-in-place-of-numbers, `null`, booleans, nested objects, unknown
  keys, missing keys, duplicate keys, non-array roots and malformed JSON are all rejected with a
  named error code and the offending row index.
- Nothing is ever dropped silently. If a field cannot be imported, the import fails; it does not
  succeed with the field removed.

Values between `2^53` and `2^64-1` are therefore representable on-chain and in the golden
vectors, but not importable from JSON in version 1. This is a documented limitation, not a
silent truncation.

## 5a. Deadlines are derived on chain, from windows

An approved pack promises *windows* ("60 seconds to deliver"), while enforcement needs *absolute*
deadlines. Version 1 originally had the client compute the absolute deadlines and pass them in.
That was wrong in a small but corrosive way: the client reads the latest block, the transaction
mines a block or two later, and the delivered window is then a second or two shorter than the pack
promised. An exact agreement check was impossible, and the only alternative was a fuzzy one.

`createJob` now takes `deliveryWindowSeconds` and `settlementWindowSeconds` as `uint32` and derives

```
deliveryDeadline = block.timestamp + deliveryWindowSeconds
settlementExpiry = deliveryDeadline + settlementWindowSeconds
```

so `deliveryDeadline - createdAt` is exactly the window the pack promised, and the agreement
validator checks it with equality rather than tolerance. The terms digest still binds the absolute
deadlines, because those are what the contract enforces.

## 6. Terms digest

```
TERMS_TYPEHASH = keccak256("AcceptanceTermsV1(uint256 chainId,address escrow,uint256 jobId,address buyer,address provider,address paymentToken,uint256 amount,bytes32 sourceDigest,uint16 requiredRowCount,bytes32 policyId,uint16 policyVersion,uint8 ruleMask,bytes32 packDigest,uint64 deliveryDeadline,uint64 settlementExpiry)")

termsDigest = keccak256(abi.encode(
    TERMS_TYPEHASH,
    block.chainid,
    address(escrow),
    jobId,
    buyer,
    provider,
    paymentToken,
    amount,
    sourceDigest,
    requiredRowCount,
    policyId,
    policyVersion,
    ruleMask,
    packDigest,
    deliveryDeadline,
    settlementExpiry
))
```

The digest is computed **by the contract** at `createJob` and stored. `acceptJob` and `fundJob`
each take the digest the caller expects and revert on mismatch, so a party can never approve
terms other than the ones stored.

Because `chainId`, the escrow address and the job ID are inside the digest, a digest computed for
one job, one contract instance or one chain is not valid for any other. Version 1 uses on-chain
transaction arguments plus role checks rather than off-chain signatures, so this binding is
tested through transaction arguments, not through signature-replay tests.

## 7. Policy identity

```
policyId      = keccak256("acceptance-mvp/catalogue-normalization/v1")
policyVersion = 1
ruleMask      = 0x0F   // all four rules; version 1 accepts no other value
```

`ruleMask` exists so the digest binds the rule set. Version 1 requires all four rules and rejects
any other mask at `createJob`, so a later version cannot reinterpret an old job's rules.

## 8. Acceptance pack digest

The acceptance pack is the human-readable agreement: the ordered clause list, each clause's
coverage classification, the rule set, and the payment/expiry policy. `packDigest` is
`keccak256(utf8(canonicalPackJson))` where `canonicalPackJson` is `JSON.stringify` over a fixed
key order defined in `src/shared/pack.ts`. The contract does not parse the pack; it binds it.

`createJob` requires `unsupportedClauseCount == 0`. A pack containing a clause classified
`EXTERNAL_ASSERTION` or `JUDGEMENT` cannot enter the automatic flow. The only way forward is an
explicit scope revision, which produces a **new pack version** in which the clause is still
listed and visibly marked `EXCLUDED_BY_REVISION` with its reason. Clauses are never removed
silently, and a revision cannot change an already-created job.
