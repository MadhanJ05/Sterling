/**
 * The question this file exists to answer: can anyone — buyer, provider, deployer, the demo
 * server, or a contract written to attack it — obtain an outcome the policy did not produce?
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ContractFactory, parseUnits } from "ethers";
import * as jobs from "../src/chain/jobs.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { AMOUNT, balances, expectRevert, fundedJob, harness, makeJob, type Harness } from "./helpers.ts";

/** Deploys a hostile token plus a dedicated escrow bound to it. */
async function deployHostileTokenEscrow(h: Harness) {
  const tokenArt = h.chain.artifacts.contracts["ReentrantToken"]!;
  const evil = await new ContractFactory(tokenArt.abi, tokenArt.bytecode, h.chain.wallets.deployer).deploy();
  await evil.waitForDeployment();
  const address = await evil.getAddress();
  const escrowArt = h.chain.artifacts.contracts["AcceptanceEscrow"]!;
  const escrow = await new ContractFactory(escrowArt.abi, escrowArt.bytecode, h.chain.wallets.deployer)
    .deploy(h.dep.addresses.policy, address);
  await escrow.waitForDeployment();
  return { evil, escrow: escrow as any, address };
}

describe("no privileged bypass exists", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  it("the contract exposes no verdict argument anywhere", () => {
    for (const f of h.dep.escrow.interface.fragments as any[]) {
      if (f.type !== "function") continue;
      for (const input of f.inputs ?? []) {
        expect(
          /verdict|approve|reject|pass|fail|result|outcome/i.test(input.name ?? ""),
          `${f.name} takes an argument named ${input.name}`,
        ).toBe(false);
      }
    }
    const settle = (h.dep.escrow.interface.fragments as any[]).find((f) => f.name === "settle");
    expect(settle.inputs).toHaveLength(1);
    expect(settle.inputs[0].type).toBe("uint256");
    expect(settle.stateMutability).toBe("nonpayable");
  });

  it("the deployer has no privilege at all", async () => {
    const job = await fundedJob(h);
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-wrong-price.json"));
    const before = await balances(h);
    const escrowAsDeployer = h.dep.escrow.connect(h.chain.wallets.deployer) as any;

    // Nothing exists to call. These are the shapes an owner-privileged escrow would expose.
    for (const name of [
      "owner", "transferOwnership", "setPolicy", "withdraw", "sweep", "rescue", "pause",
      "forceSettle", "adminSettle", "setStatus", "upgradeTo",
    ]) {
      expect(typeof escrowAsDeployer[name], `${name} must not exist`).toBe("undefined");
    }

    // The one thing the deployer can do is request settlement, which runs the same policy.
    await jobs.settle(h.dep.escrow, h.chain.wallets.deployer, job.jobId);
    const after = await balances(h);
    const final = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(final.status).toBe("REJECTED");
    expect(after.deployer).toBe(before.deployer);
    expect(after.buyer).toBe(before.buyer + AMOUNT);
  });

  it("the same job settles identically no matter who asks", async () => {
    const outcomes: string[] = [];
    for (const role of ["buyer", "provider", "thirdParty", "deployer"] as const) {
      const job = await fundedJob(h);
      await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-wrong-order.json"));
      await jobs.settle(h.dep.escrow, h.chain.wallets[role], job.jobId);
      const final = await jobs.readJob(h.dep.escrow, job.jobId);
      outcomes.push(`${final.status}:${final.ruleId}:${final.failCode}`);
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toBe("REJECTED:4:6");
  });

  it("a contract calling settle gets the policy's answer, not its own", async () => {
    const art = h.chain.artifacts.contracts["SettlementCaller"]!;
    const caller = await new ContractFactory(art.abi, art.bytecode, h.chain.wallets.thirdParty).deploy();
    await caller.waitForDeployment();

    const job = await fundedJob(h);
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));
    const before = await balances(h);
    await (await (caller as any).callSettle(h.dep.addresses.escrow, job.jobId)).wait();

    const final = await jobs.readJob(h.dep.escrow, job.jobId);
    expect(final.status).toBe("PAID");
    expect((await balances(h)).provider).toBe(before.provider + AMOUNT);
    const callerBalance = await (h.dep.token as any).balanceOf(await caller.getAddress());
    expect(BigInt(callerBalance)).toBe(0n);
  });

  it("previewSettlement changes nothing", async () => {
    const job = await fundedJob(h);
    await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-missing-row.json"));
    const before = await jobs.readJob(h.dep.escrow, job.jobId);
    const preview = await (h.dep.escrow as any).previewSettlement(job.jobId);
    expect(Number(preview[0])).toBe(2);
    expect(Number(preview[1])).toBe(1);
    expect(await jobs.readJob(h.dep.escrow, job.jobId)).toEqual(before);
    expect((await balances(h)).escrow).toBeGreaterThanOrEqual(AMOUNT);
  });

  it("a reentrant payment token cannot drain the escrow or double-settle", async () => {
    // The escrow binds one payment token immutably, so the hostile token needs its own escrow
    // deployment. That is the point of the binding: an existing escrow can never be pointed at it.
    const { evil, escrow: hostileEscrow, address: evilAddress } = await deployHostileTokenEscrow(h);
    const escrowAddress = await hostileEscrow.getAddress();
    const amount = parseUnits("5", 6);
    await (await (evil as any).mint(h.chain.addresses.buyer, amount * 10n)).wait();

    const source = loadFixture("source-batch-1.json");
    const { buildPack } = await import("../src/shared/pack.ts");
    const { payment } = await import("./helpers.ts");
    const pack = buildPack({ title: "reentrancy", source, payment: payment(amount, 600, 600, evilAddress) });
    const created = await jobs.createJob({
      escrow: hostileEscrow, buyer: h.chain.wallets.buyer, provider: h.chain.addresses.provider,
      token: evilAddress, amount, source, pack, deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
    });
    await jobs.acceptJob(hostileEscrow, h.chain.wallets.provider, created.jobId, created.termsDigest);
    await jobs.fundJob(hostileEscrow, evil as any, h.chain.wallets.buyer, created.jobId, created.termsDigest, amount);
    await jobs.submitDelivery(hostileEscrow, h.chain.wallets.provider, created.jobId, loadFixture("output-correct.json"));

    // Arm the token to call settle() again from inside its own transfer().
    await (await (evil as any).arm(escrowAddress, created.jobId, 1)).wait();
    await jobs.settle(hostileEscrow, h.chain.wallets.thirdParty, created.jobId);

    expect(await (evil as any).reentryAttempted()).toBe(true);
    expect(await (evil as any).reentrySucceeded()).toBe(false);
    const final = await jobs.readJob(hostileEscrow, created.jobId);
    expect(final.status).toBe("PAID");
    expect(BigInt(await (evil as any).balanceOf(h.chain.addresses.provider))).toBe(amount);
    expect(BigInt(await (evil as any).balanceOf(escrowAddress))).toBe(0n);
  });

  it("a reentrant token cannot turn a refund into a second payout", async () => {
    const { evil, escrow: hostileEscrow, address: evilAddress } = await deployHostileTokenEscrow(h);
    const escrowAddress = await hostileEscrow.getAddress();
    const amount = parseUnits("3", 6);
    await (await (evil as any).mint(h.chain.addresses.buyer, amount * 10n)).wait();

    const source = loadFixture("source-batch-1.json");
    const { buildPack } = await import("../src/shared/pack.ts");
    const { payment } = await import("./helpers.ts");
    const created = await jobs.createJob({
      escrow: hostileEscrow, buyer: h.chain.wallets.buyer, provider: h.chain.addresses.provider,
      token: evilAddress, amount, source,
      pack: buildPack({ title: "reentrancy-refund", source, payment: payment(amount, 30, 30, evilAddress) }),
      deliveryWindowSeconds: 30, settlementWindowSeconds: 30,
    });
    await jobs.acceptJob(hostileEscrow, h.chain.wallets.provider, created.jobId, created.termsDigest);
    await jobs.fundJob(hostileEscrow, evil as any, h.chain.wallets.buyer, created.jobId, created.termsDigest, amount);
    await (await (evil as any).arm(escrowAddress, created.jobId, 2)).wait();
    await h.chain.increaseTime(61);

    const buyerBefore = BigInt(await (evil as any).balanceOf(h.chain.addresses.buyer));
    await jobs.refundExpired(hostileEscrow, h.chain.wallets.thirdParty, created.jobId);
    expect(await (evil as any).reentrySucceeded()).toBe(false);
    expect(BigInt(await (evil as any).balanceOf(h.chain.addresses.buyer))).toBe(buyerBefore + amount);
    expect(BigInt(await (evil as any).balanceOf(escrowAddress))).toBe(0n);
  });
});

describe("a policy that cannot answer leaves the job pending with no override", () => {
  it("INDETERMINATE does not settle, and only the agreed expiry path remains", async () => {
    const h = await harness("IndeterminatePolicy");
    try {
      const job = await fundedJob(h, { deliveryWindowSeconds: 60, settlementWindowSeconds: 60 });
      await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));

      const err = await expectRevert(() => jobs.settle(h.dep.escrow, h.chain.wallets.buyer, job.jobId), h.dep.escrow);
      expect(err.name).toBe("EvaluationIndeterminate");
      const stillPending = await jobs.readJob(h.dep.escrow, job.jobId);
      expect(stillPending.status).toBe("SUBMITTED");
      expect(stillPending.verdict).toBe(0);
      expect((await balances(h)).escrow).toBe(AMOUNT);

      // No admin route appears just because evaluation failed.
      const before = await balances(h);
      await h.chain.increaseTime(121);
      await jobs.refundExpired(h.dep.escrow, h.chain.wallets.thirdParty, job.jobId);
      expect((await jobs.readJob(h.dep.escrow, job.jobId)).status).toBe("EXPIRED");
      expect((await balances(h)).buyer).toBe(before.buyer + AMOUNT);
    } finally {
      await h.close();
    }
  });

  it("a reverting policy degrades to INDETERMINATE rather than inventing a verdict", async () => {
    const h = await harness("RevertingPolicy");
    try {
      const job = await fundedJob(h, { deliveryWindowSeconds: 60, settlementWindowSeconds: 60 });
      await jobs.submitDelivery(h.dep.escrow, h.chain.wallets.provider, job.jobId, loadFixture("output-correct.json"));
      const err = await expectRevert(() => jobs.settle(h.dep.escrow, h.chain.wallets.buyer, job.jobId), h.dep.escrow);
      expect(err.name).toBe("EvaluationIndeterminate");
      expect(err.args[0]).toBe("104");
      expect((await jobs.readJob(h.dep.escrow, job.jobId)).status).toBe("SUBMITTED");
    } finally {
      await h.close();
    }
  });
});
