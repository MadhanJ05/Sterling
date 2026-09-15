import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session } from "../src/chain/session.ts";
import { verifyBundle, type EvidenceBundle } from "../src/shared/evidence.ts";
import { reviseScope } from "../src/shared/pack.ts";

describe("evidence bundle export and offline verification", () => {
  let session: Session;
  let paid: EvidenceBundle;
  let rejected: EvidenceBundle;
  let expired: EvidenceBundle;

  beforeAll(async () => {
    session = await Session.start();
    const a = await session.createJob("pass");
    await session.accept(a.jobId); await session.fund(a.jobId);
    await session.submit(a.jobId); await session.settle(a.jobId);
    paid = await session.exportEvidence(a.jobId);

    const b = await session.createJob("fail-price");
    await session.accept(b.jobId); await session.fund(b.jobId);
    await session.submit(b.jobId); await session.settle(b.jobId);
    rejected = await session.exportEvidence(b.jobId);

    const c = await session.createJob("expiry");
    await session.accept(c.jobId); await session.fund(c.jobId);
    await session.advanceTime(200);
    await session.refundExpired(c.jobId);
    expired = await session.exportEvidence(c.jobId);
  }, 180_000);

  afterAll(async () => { await session?.close(); });

  it("verifies a clean paid bundle", () => {
    const r = verifyBundle(paid);
    expect(r.lines.filter((l) => !l.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(paid.job.status).toBe("PAID");
    expect(paid.recordedVerdict.verdictName).toBe("PASS");
  });

  it("verifies a rejected bundle and reproduces the failing rule", () => {
    const r = verifyBundle(rejected);
    expect(r.ok).toBe(true);
    expect(rejected.recordedVerdict.ruleId).toBe(3);
    expect(r.lines.find((l) => l.name === "recorded verdict reproduces")!.detail).toMatch(/Rule 3/);
  });

  it("verifies an expired bundle, which carries no delivery and no verdict", () => {
    const r = verifyBundle(expired);
    expect(r.ok).toBe(true);
    expect(expired.delivery).toBeNull();
    expect(expired.recordedVerdict.verdictName).toBe("INDETERMINATE");
    expect(expired.job.status).toBe("EXPIRED");
  });

  it("always states what replay does not establish, starting with payment", () => {
    for (const b of [paid, rejected, expired]) {
      const r = verifyBundle(b);
      expect(r.notVerified[0]).toMatch(/Whether any payment actually occurred/);
      expect(r.sections.find((x) => x.key === "settlementVerified")!.verdict).toBe("NOT_CHECKED");
      expect(b.caveats.join(" ")).toMatch(/does not prove that the recorded payment occurred/);
      expect(b.caveats.join(" ")).toMatch(/not evidence of customer demand/);
    }
  });

  it("catches a tampered delivery row", () => {
    const tampered = structuredClone(paid);
    tampered.delivery![0]!.priceCents = "1";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "delivery commitment")!.ok).toBe(false);
  });

  it("catches a tampered source row", () => {
    const tampered = structuredClone(paid);
    tampered.source[0]!.productId = "424242";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "source commitment")!.ok).toBe(false);
  });

  it("catches a rewritten verdict", () => {
    const tampered = structuredClone(rejected);
    tampered.recordedVerdict = { verdict: 1, verdictName: "PASS", ruleId: 0, failCode: 0, detailA: "0", detailB: "0" };
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "recorded verdict reproduces")!.ok).toBe(false);
  });

  it("catches a swapped payment recipient in the terms", () => {
    const tampered = structuredClone(paid);
    tampered.terms.provider = "0x000000000000000000000000000000000000dEaD";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "terms digest")!.ok).toBe(false);
  });

  it("catches terms lifted onto another chain or contract", () => {
    for (const mutate of [
      (b: EvidenceBundle) => { b.terms.chainId = "8453"; },
      (b: EvidenceBundle) => { b.terms.escrow = "0x000000000000000000000000000000000000bEEF"; },
      (b: EvidenceBundle) => { b.terms.jobId = "999"; },
    ]) {
      const tampered = structuredClone(paid);
      mutate(tampered);
      expect(verifyBundle(tampered).ok).toBe(false);
    }
  });

  it("catches a pack swapped after the fact", () => {
    const tampered = structuredClone(paid);
    tampered.pack.clauses[3]!.text = "Rows may be in any order.";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "acceptance pack commitment")!.ok).toBe(false);
  });

  it("flags a bundle whose pack was never fully checkable", () => {
    const tampered = structuredClone(paid);
    tampered.pack = reviseScope(
      { ...tampered.pack, clauses: [...tampered.pack.clauses, {
        id: "CX", text: "Make it good.", coverage: "JUDGEMENT", ruleId: null, note: "smuggled in",
      }] },
      "CX", "reason",
    );
    tampered.pack.clauses.find((c) => c.id === "CX")!.coverage = "JUDGEMENT";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === "agreement validates against the terms")!.ok).toBe(false);
  });

  it("contains no key material", () => {
    const text = JSON.stringify(paid);
    expect(text).not.toMatch(/privateKey|mnemonic|secretKey/i);
    for (const w of Object.values(session.chain.wallets)) {
      expect(text).not.toContain(w.privateKey);
      expect(text).not.toContain(w.privateKey.slice(2));
    }
  });

  it("records the exact build that produced it", () => {
    expect(paid.build.solcVersion).toMatch(/^0\.8\.37/);
    expect(paid.build.sourcesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(paid.build.encodingVersion).toBe(1);
    expect(paid.chain.chainId).toBe(31337);
    expect(paid.transactions.length).toBeGreaterThanOrEqual(5);
    for (const t of paid.transactions) {
      expect(t.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(t.status).toBe(1);
    }
  });
});
