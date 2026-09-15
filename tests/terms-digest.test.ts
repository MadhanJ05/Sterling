import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { termsDigest } from "../src/shared/encoding.ts";
import { verifyTermsIndependently } from "../src/chain/jobs.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { harness, makeJob, type Harness } from "./helpers.ts";

describe("terms digest: cross-implementation agreement and domain binding", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  it("the contract's stored digest equals the TypeScript single-call encoding", async () => {
    for (const fixture of ["source-batch-1.json", "source-batch-2.json", "source-batch-3.json"]) {
      const job = await makeJob(h, { source: loadFixture(fixture) });
      const v = await verifyTermsIndependently(h.dep.escrow, job.jobId, BigInt(h.chain.chainId));
      expect(v.ok, `${fixture}: local ${v.localDigest} vs chain ${v.chainDigest}`).toBe(true);
      expect(v.localDigest).toBe(job.termsDigest);
      // termsDigestOf() recomputes from storage and must agree with what was stored at creation.
      expect(await (h.dep.escrow as any).termsDigestOf(job.jobId)).toBe(job.termsDigest);
    }
  });

  it("two jobs with identical parameters get different digests", async () => {
    const source = loadFixture("source-batch-1.json");
    const a = await makeJob(h, { source });
    const b = await makeJob(h, { source });
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.termsDigest).not.toBe(b.termsDigest);
  });

  it("the digest is bound to chain id, escrow address and job id", async () => {
    const job = await makeJob(h);
    const { terms } = await verifyTermsIndependently(h.dep.escrow, job.jobId, BigInt(h.chain.chainId));
    expect(termsDigest(terms)).toBe(job.termsDigest);
    expect(termsDigest({ ...terms, chainId: 8453n })).not.toBe(job.termsDigest);
    expect(termsDigest({ ...terms, escrow: h.dep.addresses.policy })).not.toBe(job.termsDigest);
    expect(termsDigest({ ...terms, jobId: terms.jobId + 1n })).not.toBe(job.termsDigest);
  });

  it("every bound field changes the digest", async () => {
    const job = await makeJob(h);
    const { terms } = await verifyTermsIndependently(h.dep.escrow, job.jobId, BigInt(h.chain.chainId));
    const variants = {
      buyer: { ...terms, buyer: h.chain.addresses.thirdParty },
      provider: { ...terms, provider: h.chain.addresses.thirdParty },
      paymentToken: { ...terms, paymentToken: h.dep.addresses.policy },
      amount: { ...terms, amount: terms.amount + 1n },
      sourceDigest: { ...terms, sourceDigest: "0x" + "11".repeat(32) },
      requiredRowCount: { ...terms, requiredRowCount: terms.requiredRowCount + 1 },
      policyId: { ...terms, policyId: "0x" + "22".repeat(32) },
      policyVersion: { ...terms, policyVersion: 2 },
      ruleMask: { ...terms, ruleMask: 0x07 },
      packDigest: { ...terms, packDigest: "0x" + "33".repeat(32) },
      deliveryDeadline: { ...terms, deliveryDeadline: terms.deliveryDeadline + 1n },
      settlementExpiry: { ...terms, settlementExpiry: terms.settlementExpiry + 1n },
    };
    for (const [name, t] of Object.entries(variants)) {
      expect(termsDigest(t), `changing ${name} must change the digest`).not.toBe(job.termsDigest);
    }
  });
});
