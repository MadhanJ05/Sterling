import { Contract, parseUnits } from "ethers";
import { startLocalChain, deployAll, type LocalChain, type Deployment } from "../src/chain/chain.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { buildPack, type AcceptancePack, type PaymentPolicy } from "../src/shared/pack.ts";
import type { RecordRow } from "../src/shared/types.ts";
import * as jobs from "../src/chain/jobs.ts";

export const AMOUNT = parseUnits("25", 6);
export const MINT = parseUnits("1000", 6);

/**
 * A pack now names the payment token by address, which is only known once a harness has deployed
 * one. `harness()` records it here so the many existing `payment()` call sites stay unchanged and
 * still produce a pack that matches the escrow's approved token.
 */
let currentPaymentToken = "0x0000000000000000000000000000000000000001";

export const payment = (
  amount = AMOUNT, deliveryWindowSeconds = 3600, settlementWindowSeconds = 3600,
  paymentToken = currentPaymentToken,
): PaymentPolicy => ({
  tokenSymbol: "mUSD",
  paymentToken,
  tokenDecimals: 6,
  amountBaseUnits: amount.toString(),
  deliveryWindowSeconds,
  settlementWindowSeconds,
});

export interface Harness {
  chain: LocalChain;
  dep: Deployment;
  close(): Promise<void>;
}

export async function harness(policyName?: string): Promise<Harness> {
  const chain = await startLocalChain();
  const dep = await deployAll(chain, policyName);
  currentPaymentToken = dep.addresses.token;
  const token = dep.token as any;
  for (const role of ["buyer", "provider", "thirdParty"] as const) {
    await (await token.mint(chain.addresses[role], MINT)).wait();
  }
  return { chain, dep, close: () => chain.close() };
}

export interface FullJobOpts {
  source?: RecordRow[];
  pack?: AcceptancePack;
  amount?: bigint;
  deliveryWindowSeconds?: number;
  settlementWindowSeconds?: number;
  /**
   * Negative tests only: lets a test create a job whose on-chain unsupported-clause count
   * contradicts its own pack, so the client-side refusal can be proven. No production path
   * supplies this.
   */
  unsupportedClauseCountOverrideForNegativeTests?: number;
}

/** Creates a job and returns everything a test needs about it. */
export async function makeJob(h: Harness, opts: FullJobOpts = {}) {
  const source = opts.source ?? loadFixture("source-batch-1.json");
  const amount = opts.amount ?? AMOUNT;
  const deliveryWindowSeconds = opts.deliveryWindowSeconds ?? 3600;
  const settlementWindowSeconds = opts.settlementWindowSeconds ?? 3600;
  const pack =
    opts.pack ??
    buildPack({ title: "Test job", source, payment: payment(amount, deliveryWindowSeconds, settlementWindowSeconds) });
  const created = await jobs.createJob({
    escrow: h.dep.escrow,
    buyer: h.chain.wallets.buyer,
    provider: h.chain.addresses.provider,
    token: h.dep.addresses.token,
    amount,
    source,
    pack,
    deliveryWindowSeconds,
    settlementWindowSeconds,
    ...(opts.unsupportedClauseCountOverrideForNegativeTests !== undefined
      ? { unsupportedClauseCountOverride: opts.unsupportedClauseCountOverrideForNegativeTests }
      : {}),
  });
  return { ...created, source, pack, amount };
}

/** Creates, accepts and funds in one step, for tests that are about what happens afterwards. */
export async function fundedJob(h: Harness, opts: FullJobOpts = {}) {
  const job = await makeJob(h, opts);
  await jobs.acceptJob(h.dep.escrow, h.chain.wallets.provider, job.jobId, job.termsDigest);
  await jobs.fundJob(
    h.dep.escrow, h.dep.token, h.chain.wallets.buyer, job.jobId, job.termsDigest, job.amount,
  );
  return job;
}

export async function balances(h: Harness) {
  const token = h.dep.token as any;
  const of = async (a: string) => BigInt(await token.balanceOf(a));
  return {
    buyer: await of(h.chain.addresses.buyer),
    provider: await of(h.chain.addresses.provider),
    thirdParty: await of(h.chain.addresses.thirdParty),
    deployer: await of(h.chain.addresses.deployer),
    escrow: await of(h.dep.addresses.escrow),
  };
}

export async function expectRevert(fn: () => Promise<unknown>, escrow: Contract): Promise<{ name: string; args: string[]; raw: string }> {
  try {
    await fn();
  } catch (e) {
    return jobs.decodeRevert(escrow, e);
  }
  throw new Error("expected a revert, but the call succeeded");
}
