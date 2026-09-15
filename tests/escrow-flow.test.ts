import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseUnits } from "ethers";
import * as jobs from "../src/chain/jobs.ts";
import { loadExpectations, loadFixture } from "../src/chain/fixtures.ts";
import { buildPack, coverage, packDigest, reviseScope } from "../src/shared/pack.ts";
import { validateAgreement } from "../src/shared/agreement.ts";
import { canonicalDigest } from "../src/shared/encoding.ts";
import { AMOUNT, balances, expectRevert, fundedJob, harness, makeJob, payment, type Harness } from "./helpers.ts";

const expectations = loadExpectations();
const source = () => loadFixture("source-batch-1.json");

describe("escrow: agreement, delivery, settlement", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  // ---------------------------------------------------------------- happy path

  it("a conforming delivery pays exactly the provider, exactly once", async () => {
    const before = await balances(h);
    const job = await fundedJob(h);
    expect((await balances(h)).escrow).toBe(before.escrow + AMOUNT);

    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));
    const submitted = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.deliveryDigest).toBe(canonicalDigest(loadFixture("output-correct.json")));

    // Anyone may request settlement; the requester does not choose the outcome.
    await jobs.settle(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);
    const after = await balances(h);
    const final = await jobs.readJob(h.dep.escrow, job.jobId);

    expect(final.status).toBe("PAID");
    expect(final.verdict).toBe(1);
    expect(after.provider).toBe(before.provider + AMOUNT);
    expect(after.buyer).toBe(before.buyer - AMOUNT);
    expect(after.escrow).toBe(before.escrow);
    expect(after.thirdParty).toBe(before.thirdParty);
    expect(after.deployer).toBe(before.deployer);
  });

  // -------------------------------------------------------- every flawed fixture

  for (const c of expectations.cases.filter((x: any) => x.verdict === "FAIL")) {
    it(`${c.output} fails rule ${c.ruleId} on chain and refunds the buyer exactly once`, async () => {
      const before = await balances(h);
      const job = await fundedJob(h);
      const output = loadFixture(c.output);

      // A representable but nonconforming delivery must be accepted, so a genuine FAIL is reachable.
      await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, output);
      await jobs.settle(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);

      const final = await jobs.readJob(h.dep.escrow, job.jobId);
      expect(final.status).toBe("REJECTED");
      expect(final.verdict).toBe(2);
      expect(final.ruleId).toBe(c.ruleId);
      expect(final.failCode).toBe(c.failCode);
      if (c.detailA !== undefined) expect(final.detailA).toBe(String(c.detailA));
      if (c.detailB !== undefined) expect(final.detailB).toBe(String(c.detailB));

      const after = await balances(h);
      expect(after.buyer).toBe(before.buyer);
      expect(after.provider).toBe(before.provider);
      expect(after.escrow).toBe(before.escrow);
    });
  }

  // ------------------------------------------------- unsupported material clause

  it("a pack with a judgement clause cannot enter the automatic flow", async () => {
    const pack = buildPack({
      title: "With a subjective clause", source: source(), payment: payment(), includeSubjectiveClause: true,
    });
    expect(coverage(pack).fullyAutomatic).toBe(false);

    const err = await expectRevert(() => makeJob(h, { pack }), h.dep.escrow);
    expect(err.name).toBe("UnsupportedClausesPresent");
    expect(err.args[0]).toBe("1");
  });

  it("an explicit scope revision is the only way forward, and it is visible", async () => {
    const v1 = buildPack({
      title: "With a subjective clause", source: source(), payment: payment(), includeSubjectiveClause: true,
    });
    const v2 = reviseScope(v1, "C5", "Descriptions are reviewed by a person, outside this agreement.");
    const job = await makeJob(h, { pack: v2 });
    const onChain = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(onChain.status).toBe("CREATED");
    expect(onChain.terms.packDigest).toBe(job.packDigest);
    // The clause is still in the approved pack, marked, not deleted.
    expect(v2.clauses.find((c) => c.id === "C5")!.coverage).toBe("EXCLUDED_BY_REVISION");
  });

  it("an on-chain unsupported-clause count of zero is a bare claim the contract cannot check", async () => {
    const pack = buildPack({
      title: "Count contradicts the pack", source: source(), payment: payment(), includeSubjectiveClause: true,
    });
    // A client can force the count to zero, and the job is created. The contract cannot parse a
    // pack, so it has no way to know the count is false.
    const job = await makeJob(h, { pack, unsupportedClauseCountOverrideForNegativeTests: 0 });
    const onChain = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(onChain.status).toBe("CREATED");
    expect(onChain.terms.packDigest).toBe(job.packDigest);
    expect(coverage(pack).fullyAutomatic).toBe(false);

    // What stops it is the agreement validator, which every client runs before agreeing. It reads
    // the pack the digest actually commits to and refuses on its contents, not on the count.
    const verified = await jobs.verifyTermsIndependently(h.dep.escrow, job.jobId, BigInt(h.chain.chainId));
    const report = validateAgreement({
      pack,
      terms: verified.terms,
      storedTermsDigest: verified.chainDigest,
      createdAt: onChain.createdAt,
      sourceRows: onChain.source,
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("PACK_NOT_FULLY_AUTOMATIC");

    // The real supplier process refusing this job is proven end to end in
    // tests/regression-review.test.ts, which spawns it rather than calling the validator directly.
  });

  it("the validator refuses a pack that contradicts the job in any single field", async () => {
    const job = await makeJob(h);
    const verified = await jobs.verifyTermsIndependently(h.dep.escrow, job.jobId, BigInt(h.chain.chainId));
    const onChain = await jobs.readJob(h.dep.escrow, job.jobId);
    const base = {
      terms: verified.terms,
      storedTermsDigest: verified.chainDigest,
      createdAt: onChain.createdAt,
      sourceRows: onChain.source,
    };
    expect(validateAgreement({ ...base, pack: job.pack }).ok).toBe(true);

    const mutations: [string, (p: any) => void][] = [
      ["AMOUNT_MISMATCH", (p) => { p.payment.amountBaseUnits = "1"; }],
      ["PACK_SOURCE_DIGEST_MISMATCH", (p) => { p.sourceDigest = "0x" + "11".repeat(32); }],
      ["ROW_COUNT_MISMATCH", (p) => { p.requiredRowCount = 11; }],
      ["PAYMENT_TOKEN_MISMATCH", (p) => { p.payment.paymentToken = "0x000000000000000000000000000000000000dEaD"; }],
      ["PACK_FORMAT_UNSUPPORTED", (p) => { p.packFormat = "acceptance-pack/v1"; }],
      ["CLAUSE_TEXT_NOT_FROM_TEMPLATE", (p) => { p.clauses[0].text = "Roughly the right number of rows."; }],
      ["CLAUSE_RULE_ID_INVALID", (p) => { p.clauses[0].ruleId = 9; }],
      ["CLAUSE_RULE_DUPLICATED", (p) => { p.clauses[1].ruleId = 1; p.clauses[1].text = p.clauses[0].text; }],
      ["PACK_POLICY_MISMATCH", (p) => { p.checkerPolicyVersion = 2; }],
      ["DELIVERY_WINDOW_MISMATCH", (p) => { p.payment.deliveryWindowSeconds = 1200; }],
      ["SETTLEMENT_WINDOW_MISMATCH", (p) => { p.payment.settlementWindowSeconds = 1200; }],
    ];
    for (const [code, mutate] of mutations) {
      const forged = structuredClone(job.pack) as any;
      mutate(forged);
      const r = validateAgreement({ ...base, pack: forged });
      expect(r.ok, `${code} was not caught`).toBe(false);
      expect(r.issues.map((i) => i.code), `expected ${code}, got ${r.summary}`).toContain(code);
    }
  });

  // ------------------------------------------------------------- role enforcement

  it("only the provider can accept", async () => {
    const job = await makeJob(h);
    for (const role of ["buyer", "thirdParty", "deployer"] as const) {
      const err = await expectRevert(
        () => jobs.acceptJob(h.dep.escrow, h.chain.wallets[role], job.jobId, job.termsDigest), h.dep.escrow,
      );
      expect(err.name, `${role} accepting`).toBe("NotProvider");
    }
  });

  it("only the buyer can fund, and only after the provider has accepted", async () => {
    const job = await makeJob(h);
    const early = await expectRevert(
      () => jobs.fundJob(h.dep.escrow, h.dep.token, h.chain.wallets.buyer, job.jobId, job.termsDigest, job.amount),
      h.dep.escrow,
    );
    expect(early.name).toBe("WrongStatus");

    await jobs.acceptJob(h.dep.escrow, h.chain.wallets.provider, job.jobId, job.termsDigest);
    for (const role of ["provider", "thirdParty", "deployer"] as const) {
      const err = await expectRevert(
        () => jobs.fundJob(h.dep.escrow, h.dep.token, h.chain.wallets[role], job.jobId, job.termsDigest, job.amount),
        h.dep.escrow,
      );
      expect(err.name, `${role} funding`).toBe("NotBuyer");
    }
  });

  it("only the provider can submit", async () => {
    const job = await fundedJob(h);
    for (const role of ["buyer", "thirdParty", "deployer"] as const) {
      const err = await expectRevert(
        () => jobs.submitDelivery(h.dep.escrow, h.chain.wallets[role], job.jobId, loadFixture("output-correct.json")),
        h.dep.escrow,
      );
      expect(err.name, `${role} submitting`).toBe("NotProvider");
    }
  });

  it("only the buyer can cancel, and only before funding", async () => {
    const a = await makeJob(h);
    const wrong = await expectRevert(
      () => (h.dep.escrow.connect(h.chain.wallets.thirdParty) as any).cancelBeforeFunding(a.jobId), h.dep.escrow,
    );
    expect(wrong.name).toBe("NotBuyer");
    await (h.dep.escrow.connect(h.chain.wallets.buyer) as any).cancelBeforeFunding(a.jobId);
    expect((await jobs.readJob(h.dep.escrow, a.jobId)).status).toBe("CANCELLED");

    const funded = await fundedJob(h);
    const err = await expectRevert(
      () => (h.dep.escrow.connect(h.chain.wallets.buyer) as any).cancelBeforeFunding(funded.jobId), h.dep.escrow,
    );
    expect(err.name).toBe("WrongStatus");
    expect((await jobs.readJob(h.dep.escrow, funded.jobId)).status).toBe("FUNDED");
  });

  // ---------------------------------------------------------- terms substitution

  it("an approval for one job is not valid for another", async () => {
    const a = await makeJob(h);
    const b = await makeJob(h);
    const err = await expectRevert(
      () => jobs.acceptJob(h.dep.escrow, h.chain.wallets.provider, b.jobId, a.termsDigest), h.dep.escrow,
    );
    expect(err.name).toBe("TermsDigestMismatch");
    expect((await jobs.readJob(h.dep.escrow, b.jobId)).status).toBe("CREATED");
  });

  it("funding with a stale digest is rejected even after a valid acceptance", async () => {
    const a = await makeJob(h);
    const b = await makeJob(h);
    await jobs.acceptJob(h.dep.escrow, h.chain.wallets.provider, b.jobId, b.termsDigest);
    const err = await expectRevert(
      () => jobs.fundJob(h.dep.escrow, h.dep.token, h.chain.wallets.buyer, b.jobId, a.termsDigest, b.amount),
      h.dep.escrow,
    );
    expect(err.name).toBe("TermsDigestMismatch");
  });

  it("there is no way to change the source, policy, recipient or terms of an existing job", async () => {
    const job = await fundedJob(h);
    const before = await jobs.readJob(h.dep.escrow, job.jobId);
    const abi = (h.dep.escrow.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name as string);
    const mutators = abi.filter((n) =>
      // No /i flag: with it, [A-Z] would also match "settle".
      /^(set[A-Z]|update|change|replace|override|force|admin|owner|rescue|sweep|withdraw|upgrade|pause|migrate|initialize)/.test(n),
    );
    expect(mutators, `unexpected mutating functions: ${mutators.join(", ")}`).toEqual([]);
    expect(abi.sort()).toEqual([
      "MIN_DELIVERY_WINDOW", "MIN_SETTLEMENT_WINDOW", "TERMS_TYPEHASH", "acceptJob", "cancelBeforeFunding",
      "createJob", "expectedPolicyId", "expectedPolicyVersion", "expectedRuleMask", "fundJob", "getJob",
      "getOutput", "getSource", "jobCount", "paymentToken", "policy", "previewSettlement",
      "refundExpired", "settle", "submitAndSettle", "submitDelivery", "termsDigestOf", "totalLocked",
    ]);
    expect(await jobs.readJob(h.dep.escrow, job.jobId)).toEqual(before);
  });

  it("the policy address is immutable and matches the one bound into the terms", async () => {
    const escrow = h.dep.escrow as any;
    expect(await escrow.policy()).toBe(h.dep.addresses.policy);
    expect(await escrow.expectedPolicyId()).toBe(await (h.dep.policy as any).policyId());
    const job = await makeJob(h);
    const onChain = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(onChain.terms.policyId).toBe(await escrow.expectedPolicyId());
    expect(onChain.terms.policyVersion).toBe(1);
    expect(onChain.terms.ruleMask).toBe(0x0f);
  });

  // -------------------------------------------------- delivery cannot be swapped

  it("settlement reads the stored delivery; no alternative rows can be supplied", async () => {
    const job = await fundedJob(h);
    const bad = loadFixture("output-wrong-order.json");
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, bad);

    // settle() takes a job id and nothing else. There is no overload that accepts rows.
    const settleFns = (h.dep.escrow.interface.fragments as any[])
      .filter((f) => f.type === "function" && f.name === "settle");
    expect(settleFns).toHaveLength(1);
    expect(settleFns[0].inputs.map((i: any) => i.type)).toEqual(["uint256"]);

    // Evaluating the good rows directly against the policy returns PASS...
    const direct = await (h.dep.policy as any).evaluate(
      jobs.toTuples(job.source), jobs.toTuples(loadFixture("output-correct.json")), 12, 0x0f,
    );
    expect(Number(direct[0])).toBe(1);
    // ...and changes nothing about the job, which still settles on its stored rows.
    await jobs.settle(h.dep.escrow, h.chain.wallets.buyer, job.jobId);
    const final = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(final.status).toBe("REJECTED");
    expect(final.output).toEqual(bad);
  });

  // ------------------------------------------------------------ repeat attempts

  it("a job accepts one submission and one settlement only", async () => {
    const job = await fundedJob(h);
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-wrong-order.json"));

    const resubmit = await expectRevert(
      () => jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json")),
      h.dep.escrow,
    );
    expect(resubmit.name).toBe("WrongStatus");

    const before = await balances(h);
    await jobs.settle(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);
    const mid = await balances(h);
    expect(mid.buyer).toBe(before.buyer + AMOUNT);

    for (const fn of [
      () => jobs.settle(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId),
      () => jobs.settle(h.dep.escrow, h.chain.wallets.buyer, job.jobId),
      () => jobs.refundExpired(h.dep.escrow, h.chain.wallets.buyer, job.jobId),
    ]) {
      const err = await expectRevert(fn, h.dep.escrow);
      expect(err.name).toBe("WrongStatus");
    }
    expect(await balances(h)).toEqual(mid);
  });

  it("a paid job cannot also be refunded", async () => {
    const job = await fundedJob(h);
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));
    await jobs.settle(h.dep.escrow, h.chain.wallets.provider, job.jobId);
    const after = await balances(h);
    const err = await expectRevert(() => jobs.refundExpired(h.dep.escrow, h.chain.wallets.buyer, job.jobId), h.dep.escrow);
    expect(err.name).toBe("WrongStatus");
    expect(await balances(h)).toEqual(after);
  });

  // -------------------------------------------------------- deadlines and expiry

  it("submission after the delivery deadline is refused, and the escrow still resolves", async () => {
    const job = await fundedJob(h, { deliveryWindowSeconds: 60, settlementWindowSeconds: 600 });
    await h.chain.increaseTime(61);
    const err = await expectRevert(
      () => jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json")),
      h.dep.escrow,
    );
    expect(err.name).toBe("PastDeliveryDeadline");

    const before = await balances(h);
    await h.chain.increaseTime(601);
    await jobs.refundExpired(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);
    expect((await balances(h)).buyer).toBe(before.buyer + AMOUNT);
    expect((await jobs.readJob(h.dep.escrow, job.jobId)).status).toBe("EXPIRED");
  });

  it("settlement is refused at or after expiry, and the refund path takes over", async () => {
    const job = await fundedJob(h, { deliveryWindowSeconds: 60, settlementWindowSeconds: 60 });
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));

    const early = await expectRevert(() => jobs.refundExpired(h.dep.escrow, h.chain.wallets.buyer, job.jobId), h.dep.escrow);
    expect(early.name).toBe("NotYetExpired");

    await h.chain.increaseTime(121);
    const late = await expectRevert(() => jobs.settle(h.dep.escrow, h.chain.wallets.buyer, job.jobId), h.dep.escrow);
    expect(late.name).toBe("SettlementWindowClosed");

    // A conforming delivery still loses its payment once the window closes. That is the rule, and
    // the interface must not present it as a finding about the work.
    const before = await balances(h);
    await jobs.refundExpired(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);
    const final = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(final.status).toBe("EXPIRED");
    expect(final.verdict).toBe(0);
    expect((await balances(h)).buyer).toBe(before.buyer + AMOUNT);
  });

  it("no submission at all recovers the funds through expiry", async () => {
    const before = await balances(h);
    const job = await fundedJob(h, { deliveryWindowSeconds: 30, settlementWindowSeconds: 30 });
    await h.chain.increaseTime(61);
    await jobs.refundExpired(h.dep.escrow, h.chain.wallets.buyer, job.jobId);
    const final = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(final.status).toBe("EXPIRED");
    expect(final.output).toEqual([]);
    expect(await balances(h)).toEqual(before);
  });

  it("rejects a job whose deadlines leave no room to deliver or to settle", async () => {
    const tooSoon = await expectRevert(() => makeJob(h, { deliveryWindowSeconds: 1 }), h.dep.escrow);
    expect(tooSoon.name).toBe("DeliveryWindowTooShort");
    const noRoom = await expectRevert(
      () => makeJob(h, { deliveryWindowSeconds: 60, settlementWindowSeconds: 1 }), h.dep.escrow,
    );
    expect(noRoom.name).toBe("SettlementWindowTooShort");
  });

  // --------------------------------------------------------- bounded rejections

  it("oversized and malformed inputs are bounded rejections, not verdicts", async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ productId: BigInt(i + 1), priceCents: 10n }));

    // The client-side encoder refuses first, before anything is sent.
    expect(() => canonicalDigest(tooMany)).toThrow(/at most 32/);

    // The contract enforces the same bound independently, for a client that skips that check.
    const escrowAsBuyer = h.dep.escrow.connect(h.chain.wallets.buyer) as any;
    const pack = buildPack({ title: "oversized", source: source(), payment: payment() });
    const err = await expectRevert(
      () => escrowAsBuyer.createJob(
        {
          provider: h.chain.addresses.provider, paymentToken: h.dep.addresses.token, amount: AMOUNT,
          requiredRowCount: 33, ruleMask: 0x0f, packDigest: packDigest(pack), unsupportedClauseCount: 0,
          deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
        },
        jobs.toTuples(tooMany),
      ),
      h.dep.escrow,
    );
    expect(err.name).toBe("BadRecordCount");

    const job = await fundedJob(h);
    const bigDelivery = Array.from({ length: 33 }, (_, i) => ({ productId: BigInt(i + 1), priceCents: 10n }));
    const submitErr = await expectRevert(
      () => jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, bigDelivery), h.dep.escrow,
    );
    expect(submitErr.name).toBe("BadRecordCount");
    // The job is untouched: no verdict was recorded and the escrow still holds the funds.
    const after = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(after.status).toBe("FUNDED");
    expect(after.verdict).toBe(0);
  });

  it("rejects a source with duplicate product ids at creation", async () => {
    const dup = [
      { productId: 1n, priceCents: 5n }, { productId: 2n, priceCents: 6n }, { productId: 1n, priceCents: 7n },
    ];
    const err = await expectRevert(() => makeJob(h, { source: dup }), h.dep.escrow);
    expect(err.name).toBe("DuplicateSourceId");
  });

  it("rejects a zero amount, a zero address and a provider equal to the buyer", async () => {
    const zero = await expectRevert(() => makeJob(h, { amount: 0n }), h.dep.escrow);
    expect(zero.name).toBe("ZeroAmount");
    const self = await expectRevert(
      () => jobs.createJob({
        escrow: h.dep.escrow, buyer: h.chain.wallets.buyer, provider: h.chain.addresses.buyer,
        token: h.dep.addresses.token, amount: AMOUNT, source: source(),
        pack: buildPack({ title: "self", source: source(), payment: payment() }),
        deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
      }),
      h.dep.escrow,
    );
    expect(self.name).toBe("ProviderIsBuyer");
  });

  // ----------------------------------------------------------- fund conservation

  it("reconciles balances across a mixed batch of interleaved jobs and failed transactions", async () => {
    const start = await balances(h);
    const startLocked = BigInt(await (h.dep.escrow as any).totalLocked());
    const amounts = [parseUnits("1", 6), parseUnits("7", 6), parseUnits("13", 6), parseUnits("2", 6)];
    const outcomes = ["pay", "reject", "expire", "pay"] as const;

    const created: Awaited<ReturnType<typeof fundedJob>>[] = [];
    for (const amount of amounts) created.push(await fundedJob(h, { amount, deliveryWindowSeconds: 120, settlementWindowSeconds: 120 }));

    const lockedAfterFunding = BigInt(await (h.dep.escrow as any).totalLocked());
    expect(lockedAfterFunding).toBe(startLocked + amounts.reduce((a, b) => a + b, 0n));
    expect((await balances(h)).escrow).toBe(start.escrow + amounts.reduce((a, b) => a + b, 0n));

    // A deliberately failing transaction in the middle of the batch must not move anything.
    await expectRevert(
      () => jobs.submitDelivery(h.dep.escrow, h.chain.wallets.thirdParty, created[0]!.jobId, loadFixture("output-correct.json")),
      h.dep.escrow,
    );

    for (let i = 0; i < created.length; i++) {
      if (outcomes[i] === "pay") {
        await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, created[i]!.jobId, loadFixture("output-correct.json"));
      } else if (outcomes[i] === "reject") {
        await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, created[i]!.jobId, loadFixture("output-wrong-price.json"));
      }
    }
    for (let i = 0; i < created.length; i++) {
      if (outcomes[i] !== "expire") await jobs.settle(h.dep.escrow, h.chain.wallets.thirdParty, created[i]!.jobId);
    }
    await h.chain.increaseTime(241);
    await jobs.refundExpired(h.dep.escrow, h.chain.wallets.thirdParty, created[2]!.jobId);

    const paid = amounts[0]! + amounts[3]!;
    const end = await balances(h);
    expect(end.provider).toBe(start.provider + paid);
    expect(end.buyer).toBe(start.buyer - paid);
    expect(end.escrow).toBe(start.escrow);
    expect(BigInt(await (h.dep.escrow as any).totalLocked())).toBe(startLocked);
    expect(end.thirdParty).toBe(start.thirdParty);
    expect(end.deployer).toBe(start.deployer);
  });

  it("the escrow never holds less than it owes", async () => {
    const locked = BigInt(await (h.dep.escrow as any).totalLocked());
    const held = (await balances(h)).escrow;
    expect(held).toBeGreaterThanOrEqual(locked);
  });
});
