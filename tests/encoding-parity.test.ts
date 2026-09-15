import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { canonicalBundleBytes, canonicalDigest, decodeCanonicalBundle } from "../src/shared/encoding.ts";
import { loadGoldenVectors } from "../src/chain/fixtures.ts";
import { harness, type Harness } from "./helpers.ts";
import type { RecordRow } from "../src/shared/types.ts";

const golden = loadGoldenVectors();
const rows = (v: any): RecordRow[] =>
  v.records.map((r: any) => ({ productId: BigInt(r.productId), priceCents: BigInt(r.priceCents) }));

describe("canonical encoding parity across three independent implementations", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  it("has the vectors the spec promises", () => {
    const names = golden.vectors.map((v: any) => v.name);
    expect(names).toContain("empty");
    expect(names).toContain("single-min");
    expect(names).toContain("single-max");
    expect(names).toContain("max-rows-32");
    expect(golden.encodingVersion).toBe(1);
  });

  for (const v of golden.vectors) {
    it(`TypeScript matches the hand-written Python vector: ${v.name}`, () => {
      expect(canonicalBundleBytes(rows(v))).toBe(v.bundleBytes);
      expect(canonicalDigest(rows(v))).toBe(v.digest);
    });

    it(`Solidity matches the hand-written Python vector: ${v.name}`, async () => {
      const policy = h.dep.policy as any;
      expect(await policy.canonicalBundleBytes(rows(v).map((r) => [r.productId, r.priceCents]))).toBe(v.bundleBytes);
      expect(await policy.canonicalDigest(rows(v).map((r) => [r.productId, r.priceCents]))).toBe(v.digest);
    });

    it(`round-trips through decode: ${v.name}`, () => {
      expect(decodeCanonicalBundle(v.bundleBytes)).toEqual(rows(v));
    });
  }

  it("array order is part of the commitment", () => {
    const ab = golden.vectors.find((v: any) => v.name === "pair-ab");
    const ba = golden.vectors.find((v: any) => v.name === "pair-ba");
    expect(ab.digest).not.toBe(ba.digest);
    expect(new Set(ab.records.map((r: any) => r.productId))).toEqual(new Set(ba.records.map((r: any) => r.productId)));
  });

  it("a one-cent change changes the digest", () => {
    const base: RecordRow[] = [{ productId: 1n, priceCents: 100n }];
    const bumped: RecordRow[] = [{ productId: 1n, priceCents: 101n }];
    expect(canonicalDigest(base)).not.toBe(canonicalDigest(bumped));
  });

  it("the encoded length follows the documented layout", () => {
    for (const v of golden.vectors) {
      expect((v.bundleBytes.length - 2) / 2).toBe(0x60 + 64 * v.records.length);
    }
  });
});
