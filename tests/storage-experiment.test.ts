/**
 * Safety tests for the reduced-storage experiment.
 *
 * The experiment is not part of the product and is not deployed by the app. It exists to be
 * measured. What it must not do is trade verification for gas, and the specific danger is that
 * supplying the wrong rows at settlement could become a legitimate-looking FAIL that refunds an
 * honest provider's job. Every test below is about that.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ContractFactory, parseUnits, type Contract } from "ethers";
import { startLocalChain, deployAll, type LocalChain, type Deployment } from "../src/chain/chain.ts";
import * as jobs from "../src/chain/jobs.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { buildPack, packDigest } from "../src/shared/pack.ts";
import { canonicalDigest } from "../src/shared/encoding.ts";
import type { RecordRow } from "../src/shared/types.ts";

const AMOUNT = parseUnits("25", 6);

describe("reduced-storage experiment: commitments instead of rows", () => {
  let chain: LocalChain;
  let dep: Deployment;
  let experiment: Contract;
  let address: string;

  const source = () => loadFixture("source-batch-1.json");

  beforeAll(async () => {
    chain = await startLocalChain();
    dep = await deployAll(chain);
    for (const role of ["buyer", "provider", "thirdParty"] as const) {
      await (await (dep.token as any).mint(chain.addresses[role], parseUnits("1000", 6))).wait();
    }
    const art = chain.artifacts.contracts["CommitmentEscrowExperiment"]!;
    experiment = (await new ContractFactory(art.abi, art.bytecode, chain.wallets.deployer)
      .deploy(dep.addresses.policy, dep.addresses.token)) as unknown as Contract;
    await experiment.waitForDeployment();
    address = await experiment.getAddress();
  }, 180_000);
  afterAll(async () => { await chain?.close(); });

  async function fundedJob(rows: readonly RecordRow[] = source()) {
    const pack = buildPack({
      title: "experiment",
      source: rows,
      payment: {
        tokenSymbol: "mUSD", paymentToken: dep.addresses.token, tokenDecimals: 6,
        amountBaseUnits: AMOUNT.toString(), deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
      },
    });
    const tx = await (experiment.connect(chain.wallets.buyer) as any).createJob({
      provider: chain.addresses.provider, amount: AMOUNT, requiredRowCount: rows.length,
      ruleMask: 0x0f, packDigest: packDigest(pack), unsupportedClauseCount: 0,
      deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
    }, jobs.toTuples(rows));
    await tx.wait();
    const jobId = BigInt(await (experiment as any).jobCount());
    await (await (experiment.connect(chain.wallets.provider) as any).acceptJob(jobId)).wait();
    await (await (dep.token.connect(chain.wallets.buyer) as any).approve(address, AMOUNT)).wait();
    await (await (experiment.connect(chain.wallets.buyer) as any).fundJob(jobId)).wait();
    return jobId;
  }

  const balances = async () => ({
    buyer: BigInt(await (dep.token as any).balanceOf(chain.addresses.buyer)),
    provider: BigInt(await (dep.token as any).balanceOf(chain.addresses.provider)),
    escrow: BigInt(await (dep.token as any).balanceOf(address)),
  });

  async function expectRevertNamed(fn: () => Promise<unknown>): Promise<{ name: string; args: string[] }> {
    try {
      await fn();
    } catch (e) {
      const d = jobs.decodeRevert(experiment, e);
      return { name: d.name, args: d.args };
    }
    throw new Error("expected a revert");
  }

  it("stores commitments, not rows: there is no getter that returns the source", () => {
    const names = (experiment.interface.fragments as any[]).filter((f) => f.type === "function").map((f) => f.name);
    expect(names).not.toContain("getSource");
    expect(names).not.toContain("getOutput");
    expect(names).toContain("getJob");
  });

  it("pays a conforming delivery when the supplied rows match the commitments", async () => {
    const before = await balances();
    const jobId = await fundedJob();
    const rows = source();
    const output = [...rows].sort((a, b) => (a.productId < b.productId ? -1 : 1));
    await (await (experiment.connect(chain.wallets.provider) as any)
      .submitAndSettle(jobId, jobs.toTuples(rows), jobs.toTuples(output))).wait();
    const job = await (experiment as any).getJob(jobId);
    expect(Number(job.status)).toBe(5); // PAID
    const after = await balances();
    expect(after.provider).toBe(before.provider + AMOUNT);
    expect(after.escrow).toBe(before.escrow);
  });

  it("refunds a genuinely nonconforming delivery, on the rule the checker names", async () => {
    const before = await balances();
    const jobId = await fundedJob();
    const rows = source();
    const bad = loadFixture("output-wrong-order.json");
    await (await (experiment.connect(chain.wallets.provider) as any)
      .submitAndSettle(jobId, jobs.toTuples(rows), jobs.toTuples(bad))).wait();
    const job = await (experiment as any).getJob(jobId);
    expect(Number(job.status)).toBe(6); // REJECTED
    expect(Number(job.ruleId)).toBe(4);
    expect(await balances()).toEqual(before);
  });

  it("wrong source rows at settlement revert, and are never a FAIL", async () => {
    const jobId = await fundedJob();
    const rows = source();
    const output = [...rows].sort((a, b) => (a.productId < b.productId ? -1 : 1));
    await (await (experiment.connect(chain.wallets.provider) as any)
      .submitDelivery(jobId, jobs.toTuples(output))).wait();

    const before = await balances();
    const tamperedSource = rows.map((r, i) => (i === 0 ? { ...r, priceCents: r.priceCents + 1n } : r));
    const err = await expectRevertNamed(() => (experiment.connect(chain.wallets.thirdParty) as any)
      .settle(jobId, jobs.toTuples(tamperedSource), jobs.toTuples(output)));

    expect(err.name).toBe("SourceDataMismatch");
    expect(err.args[0]).toBe(canonicalDigest(rows));
    const job = await (experiment as any).getJob(jobId);
    expect(Number(job.status)).toBe(4); // still SUBMITTED, not REJECTED
    expect(Number(job.verdict)).toBe(0);
    expect(await balances()).toEqual(before);

    // The honest provider can still be paid afterwards with the correct rows.
    await (await (experiment.connect(chain.wallets.thirdParty) as any)
      .settle(jobId, jobs.toTuples(rows), jobs.toTuples(output))).wait();
    expect(Number((await (experiment as any).getJob(jobId)).status)).toBe(5);
    expect((await balances()).provider).toBe(before.provider + AMOUNT);
  });

  it("wrong delivery rows at settlement revert, and are never a FAIL", async () => {
    const jobId = await fundedJob();
    const rows = source();
    const output = [...rows].sort((a, b) => (a.productId < b.productId ? -1 : 1));
    await (await (experiment.connect(chain.wallets.provider) as any)
      .submitDelivery(jobId, jobs.toTuples(output))).wait();

    const before = await balances();
    // A hostile third party tries to swap in a delivery that would fail the rules, so the buyer
    // gets a refund and the honest provider loses the job. This is the attack the design invites.
    const err = await expectRevertNamed(() => (experiment.connect(chain.wallets.thirdParty) as any)
      .settle(jobId, jobs.toTuples(rows), jobs.toTuples(loadFixture("output-wrong-order.json"))));

    expect(err.name).toBe("DeliveryDataMismatch");
    expect(err.args[0]).toBe(canonicalDigest(output));
    const job = await (experiment as any).getJob(jobId);
    expect(Number(job.status)).toBe(4);
    expect(Number(job.verdict)).toBe(0);
    expect(await balances()).toEqual(before);
  });

  it("an empty or truncated row set is a mismatch, not an automatic rule-1 failure", async () => {
    const jobId = await fundedJob();
    const rows = source();
    const output = [...rows].sort((a, b) => (a.productId < b.productId ? -1 : 1));
    await (await (experiment.connect(chain.wallets.provider) as any)
      .submitDelivery(jobId, jobs.toTuples(output))).wait();

    for (const fake of [[], output.slice(0, 5)]) {
      const err = await expectRevertNamed(() => (experiment.connect(chain.wallets.thirdParty) as any)
        .settle(jobId, jobs.toTuples(rows), jobs.toTuples(fake)));
      expect(err.name).toBe("DeliveryDataMismatch");
    }
    expect(Number((await (experiment as any).getJob(jobId)).status)).toBe(4);
  });

  it("keeps the same no-bypass properties as the product escrow", async () => {
    const names = (experiment.interface.fragments as any[])
      .filter((f) => f.type === "function").map((f) => f.name as string);
    expect(names.filter((n) => /^(set[A-Z]|owner|admin|withdraw|upgrade|pause|force)/.test(n))).toEqual([]);
    // Functions only: an event may of course report a verdict, it just may not accept one.
    for (const f of (experiment.interface.fragments as any[]).filter((x) => x.type === "function")) {
      for (const input of f.inputs ?? []) {
        expect(/verdict|outcome|result/i.test(input.name ?? ""), `${f.name}(${input.name})`).toBe(false);
      }
    }
    expect(await (experiment as any).paymentToken()).toBe(dep.addresses.token);
    expect(await (experiment as any).policy()).toBe(dep.addresses.policy);
  });
});
