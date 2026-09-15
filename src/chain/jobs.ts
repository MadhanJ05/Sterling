/**
 * Typed wrappers over AcceptanceEscrow. Every function here is a named action; there is no
 * generic "send this transaction" helper anywhere in the project.
 */
import { Contract, type ContractTransactionReceipt, type Wallet, type HDNodeWallet } from "ethers";
import { knownErrorInterfaces } from "../shared/errorAbis.ts";
import type { RecordRow } from "../shared/types.ts";
import { JobStatus, type JobStatusName } from "../shared/types.ts";
import { canonicalDigest, termsDigest, type TermsForDigest } from "../shared/encoding.ts";
import { packDigest, coverage, type AcceptancePack } from "../shared/pack.ts";

export type Signer = Wallet | HDNodeWallet;

/**
 * ethers' Contract has an index signature that `noUncheckedIndexedAccess` widens to `| undefined`.
 * `m()` narrows it back at the single point of use rather than sprinkling non-null assertions.
 */
function m(c: Contract): any {
  return c;
}

export function toTuples(rows: readonly RecordRow[]): [bigint, bigint][] {
  return rows.map((r) => [r.productId, r.priceCents]);
}
export function fromTuples(raw: any[]): RecordRow[] {
  return raw.map((r: any) => ({ productId: BigInt(r[0]), priceCents: BigInt(r[1]) }));
}

export interface TxInfo {
  hash: string;
  blockNumber: number;
  gasUsed: string;
  from: string;
  to: string | null;
  status: number;
}

export function txInfo(r: ContractTransactionReceipt | null): TxInfo {
  if (!r) throw new Error("no receipt");
  return {
    hash: r.hash,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed.toString(),
    from: r.from,
    to: r.to,
    status: r.status ?? 0,
  };
}

export interface CreateJobArgs {
  escrow: Contract;
  buyer: Signer;
  provider: string;
  token: string;
  amount: bigint;
  source: readonly RecordRow[];
  pack: AcceptancePack;
  deliveryWindowSeconds: number;
  settlementWindowSeconds: number;
  /**
   * Negative tests only. Normally derived from the pack's coverage report. It exists so a test can
   * build the contradiction the review found — an on-chain count of zero against a pack that says
   * otherwise — and prove the client refuses it. See docs/limitations.md on why the count alone
   * can never be trustworthy.
   */
  unsupportedClauseCountOverride?: number;
}

export interface CreatedJob {
  jobId: bigint;
  termsDigest: string;
  packDigest: string;
  sourceDigest: string;
  deliveryDeadline: number;
  settlementExpiry: number;
  tx: TxInfo;
}

export async function createJob(a: CreateJobArgs): Promise<CreatedJob> {
  const escrow = a.escrow.connect(a.buyer) as Contract;
  const pd = packDigest(a.pack);
  const cov = coverage(a.pack);

  const params = {
    provider: a.provider,
    paymentToken: a.token,
    amount: a.amount,
    requiredRowCount: a.source.length,
    ruleMask: a.pack.ruleMask,
    packDigest: pd,
    unsupportedClauseCount: a.unsupportedClauseCountOverride ?? cov.unsupportedClauseCount,
    deliveryWindowSeconds: a.deliveryWindowSeconds,
    settlementWindowSeconds: a.settlementWindowSeconds,
  };

  const tx = await m(escrow).createJob(params, toTuples(a.source));
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((l: any) => {
      try { return escrow.interface.parseLog(l); } catch { return null; }
    })
    .find((e: any) => e?.name === "JobCreated");
  if (!parsed) throw new Error("JobCreated not emitted");

  const stored = await m(escrow).getJob(parsed.args.jobId);
  return {
    jobId: BigInt(parsed.args.jobId),
    termsDigest: parsed.args.termsDigest,
    packDigest: pd,
    sourceDigest: canonicalDigest(a.source),
    deliveryDeadline: Number(stored.terms.deliveryDeadline),
    settlementExpiry: Number(stored.terms.settlementExpiry),
    tx: txInfo(receipt),
  };
}

/**
 * What a party does before agreeing: recompute the terms digest from the terms the contract
 * actually stored, using its own independent implementation, and refuse if they disagree.
 */
export async function verifyTermsIndependently(
  escrow: Contract,
  jobId: bigint,
  chainId: bigint,
): Promise<{ ok: boolean; localDigest: string; chainDigest: string; terms: TermsForDigest }> {
  const job = await m(escrow).getJob(jobId);
  const t = job.terms;
  const terms: TermsForDigest = {
    chainId,
    escrow: await escrow.getAddress(),
    jobId,
    buyer: t.buyer,
    provider: t.provider,
    paymentToken: t.paymentToken,
    amount: BigInt(t.amount),
    sourceDigest: t.sourceDigest,
    requiredRowCount: Number(t.requiredRowCount),
    policyId: t.policyId,
    policyVersion: Number(t.policyVersion),
    ruleMask: Number(t.ruleMask),
    packDigest: t.packDigest,
    deliveryDeadline: BigInt(t.deliveryDeadline),
    settlementExpiry: BigInt(t.settlementExpiry),
  };
  const localDigest = termsDigest(terms);
  return { ok: localDigest === job.termsDigest, localDigest, chainDigest: job.termsDigest, terms };
}

export async function acceptJob(escrow: Contract, provider: Signer, jobId: bigint, expected: string) {
  const tx = await m(escrow.connect(provider) as Contract).acceptJob(jobId, expected);
  return txInfo(await tx.wait());
}

export async function fundJob(
  escrow: Contract, token: Contract, buyer: Signer, jobId: bigint, expected: string, amount: bigint,
) {
  const escrowAddress = await escrow.getAddress();
  const approveTx = await m(token.connect(buyer) as Contract).approve(escrowAddress, amount);
  const approve = txInfo(await approveTx.wait());
  const tx = await m(escrow.connect(buyer) as Contract).fundJob(jobId, expected);
  return { approve, fund: txInfo(await tx.wait()) };
}

export async function submitDelivery(escrow: Contract, provider: Signer, jobId: bigint, rows: readonly RecordRow[]) {
  const tx = await m(escrow.connect(provider) as Contract).submitDelivery(jobId, toTuples(rows));
  return txInfo(await tx.wait());
}

/** One transaction: record the delivery, evaluate it, and pay or refund atomically. */
export async function submitAndSettle(escrow: Contract, provider: Signer, jobId: bigint, rows: readonly RecordRow[]) {
  const tx = await m(escrow.connect(provider) as Contract).submitAndSettle(jobId, toTuples(rows));
  return txInfo(await tx.wait());
}

export async function settle(escrow: Contract, caller: Signer, jobId: bigint) {
  const tx = await m(escrow.connect(caller) as Contract).settle(jobId);
  return txInfo(await tx.wait());
}

export async function refundExpired(escrow: Contract, caller: Signer, jobId: bigint) {
  const tx = await m(escrow.connect(caller) as Contract).refundExpired(jobId);
  return txInfo(await tx.wait());
}

export interface JobView {
  jobId: string;
  status: JobStatusName;
  statusCode: number;
  terms: {
    buyer: string; provider: string; paymentToken: string; amount: string;
    sourceDigest: string; requiredRowCount: number; policyId: string; policyVersion: number;
    ruleMask: number; packDigest: string; deliveryDeadline: number; settlementExpiry: number;
  };
  termsDigest: string;
  deliveryDigest: string;
  createdAt: number;
  submittedAt: number;
  settledAt: number;
  verdict: number;
  ruleId: number;
  failCode: number;
  detailA: string;
  detailB: string;
  source: RecordRow[];
  output: RecordRow[];
}

export async function readJob(escrow: Contract, jobId: bigint): Promise<JobView> {
  const [job, source, output] = await Promise.all([
    m(escrow).getJob(jobId),
    m(escrow).getSource(jobId),
    m(escrow).getOutput(jobId),
  ]);
  const t = job.terms;
  return {
    jobId: jobId.toString(),
    status: JobStatus[Number(job.status)] ?? "NONE",
    statusCode: Number(job.status),
    terms: {
      buyer: t.buyer,
      provider: t.provider,
      paymentToken: t.paymentToken,
      amount: t.amount.toString(),
      sourceDigest: t.sourceDigest,
      requiredRowCount: Number(t.requiredRowCount),
      policyId: t.policyId,
      policyVersion: Number(t.policyVersion),
      ruleMask: Number(t.ruleMask),
      packDigest: t.packDigest,
      deliveryDeadline: Number(t.deliveryDeadline),
      settlementExpiry: Number(t.settlementExpiry),
    },
    termsDigest: job.termsDigest,
    deliveryDigest: job.deliveryDigest,
    createdAt: Number(job.createdAt),
    submittedAt: Number(job.submittedAt),
    settledAt: Number(job.settledAt),
    verdict: Number(job.verdict),
    ruleId: Number(job.ruleId),
    failCode: Number(job.failCode),
    detailA: job.detailA.toString(),
    detailB: job.detailB.toString(),
    source: fromTuples(source),
    output: fromTuples(output),
  };
}

/**
 * Normalises a revert into { name, args } using the contract's own custom errors.
 *
 * Ganache reports revert data in several shapes depending on the RPC method, and ethers does not
 * always surface it as `error.data`. All the known shapes are checked here so that a negative
 * test asserts on the actual custom error rather than on a message string.
 */
export function decodeRevert(escrow: Contract, e: any): { name: string; args: string[]; raw: string } {
  const raw = String(e?.shortMessage ?? e?.message ?? e);
  for (const candidate of revertDataCandidates(e)) {
    for (const iface of [escrow.interface, ...knownErrorInterfaces()]) {
      try {
        const parsed = iface.parseError(candidate);
        if (parsed) return { name: parsed.name, args: parsed.args.map((a: any) => String(a)), raw };
      } catch {
        /* try the next interface */
      }
    }
  }
  const m = raw.match(/custom error '([A-Za-z0-9_]+)\(([^)]*)\)'/);
  if (m) return { name: m[1]!, args: m[2] ? m[2]!.split(",").map((x) => x.trim()) : [], raw };
  return { name: "UNKNOWN", args: [], raw };
}

/**
 * Every custom error in the project, not just the escrow's.
 *
 * A revert from the payment token — running out of test funds, for instance — used to decode as
 * UNKNOWN and surface as the useless string "missing revert data", because only the escrow's
 * interface was consulted. The registry is populated at startup by whichever side has the
 * artifacts; see src/shared/errorAbis.ts.
 */
function revertDataCandidates(e: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) out.push(v);
  };
  push(e?.data);
  push(e?.error?.data);
  const infoData = e?.info?.error?.data;
  push(infoData);
  push(infoData?.result);
  // eth_sendTransaction failures come back keyed by transaction hash.
  if (infoData && typeof infoData === "object") {
    for (const v of Object.values(infoData as Record<string, any>)) {
      push(v);
      push(v?.return);
      push(v?.result);
    }
  }
  return out;
}
