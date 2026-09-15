/**
 * Regression tests for the third independent review, 14 September 2026.
 *
 * R1 — a job's reported cash movements must come from that job's own receipts, not from the
 *      difference between wallet balances now and wallet balances when the job was created.
 * R2 — the recorded timestamps must be compared against the stored job, by the RPC check.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUnits } from "ethers";
import { Session } from "../src/chain/session.ts";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";
import { verifyBundle, type EvidenceBundle } from "../src/shared/evidence.ts";
import type { RecordRow } from "../src/shared/types.ts";

const TSX = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const AMOUNT = "25000000";

function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [TSX, join(PROJECT_ROOT, "scripts/verify-bundle.ts"), ...args], {
      cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stdout += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout }));
  });
}

const batch = (offset: bigint): RecordRow[] => [
  { productId: 903n + offset, priceCents: 199n },
  { productId: 901n + offset, priceCents: 249n },
  { productId: 902n + offset, priceCents: 359n },
];

describe("R1 — per-job cash movements come from that job's own receipts", () => {
  let session: Session;
  let dir: string;

  beforeAll(async () => {
    session = await Session.start();
    dir = mkdtempSync(join(tmpdir(), "acceptance-r1-"));
  }, 180_000);
  afterAll(async () => { await session?.close(); });

  async function verifyAgainstChain(label: string, bundle: EvidenceBundle) {
    const file = join(dir, `${label}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    const r = await runCli([file, "--rpc", session.chain.rpcUrl]);
    return { exit: r.code, claimsVerified: r.stdout.includes("on-chain settlement verified"), stdout: r.stdout };
  }

  async function completedJob(offset: bigint, title: string) {
    const job = await session.createJobFromRows(batch(offset), title);
    await session.runAutomaticForJob(job.jobId);
    return job.jobId;
  }

  it("a later job does not change an earlier job's reported payment", async () => {
    const a = await completedJob(0n, "Job A");
    const before = await session.exportEvidence(a);
    expect(before.balanceDeltas.provider).toBe(AMOUNT);
    expect(before.balanceDeltas.buyer).toBe(`-${AMOUNT}`);
    expect(verifyBundle(before).ok).toBe(true);
    expect((await verifyAgainstChain("a-before", before)).exit).toBe(0);

    // A second, entirely separate job completes.
    await completedJob(100n, "Job B");

    const after = await session.exportEvidence(a);
    expect(after.balanceDeltas, "job A's totals absorbed job B's transfers").toEqual(before.balanceDeltas);
    expect(after.job.amountBaseUnits).toBe(AMOUNT);
    const v = verifyBundle(after);
    expect(v.lines.filter((l) => !l.ok)).toEqual([]);
    const rpc = await verifyAgainstChain("a-after", after);
    expect(rpc.exit, rpc.stdout).toBe(0);
    expect(rpc.claimsVerified).toBe(true);
  });

  it("a job funded alongside another excludes the other's deposit", async () => {
    const c = await session.createJobFromRows(batch(200n), "Overlapping C");
    const d = await session.createJobFromRows(batch(300n), "Overlapping D");
    for (const j of [c, d]) {
      await session.accept(j.jobId);
      await session.fund(j.jobId);
    }
    // Both are funded; only C settles. A frozen end-of-job snapshot would still be wrong here.
    await session.submitAndSettle(c.jobId);

    const bundle = await session.exportEvidence(c.jobId);
    expect(bundle.balanceDeltas.provider).toBe(AMOUNT);
    expect(bundle.balanceDeltas.buyer).toBe(`-${AMOUNT}`);
    expect(bundle.balanceDeltas.escrow).toBe("0");
    expect(verifyBundle(bundle).lines.filter((l) => !l.ok)).toEqual([]);
    expect((await verifyAgainstChain("overlap-c", bundle)).exit).toBe(0);

    // D is still holding its deposit, which must not appear in C's record.
    expect((await session.readJob(d.jobId)).status).toBe("FUNDED");
  });

  it("a rejected job reports a round trip, not a payment", async () => {
    const job = await session.createJobFromRows(batch(400n), "Rejected job");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submitAndSettle(job.jobId, "order");
    const bundle = await session.exportEvidence(job.jobId);
    expect(bundle.job.status).toBe("REJECTED");
    expect(bundle.balanceDeltas.provider).toBe("0");
    expect(bundle.balanceDeltas.buyer).toBe("0");
    expect(bundle.balanceDeltas.escrow).toBe("0");
    expect(verifyBundle(bundle).lines.filter((l) => !l.ok)).toEqual([]);
    expect((await verifyAgainstChain("rejected", bundle)).exit).toBe(0);
  });

  it("an expiry refund reports a round trip", async () => {
    const job = await session.createJobFromRows(batch(500n), "Expired job");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.advanceTime(4000 + 4000);
    await session.refundExpired(job.jobId);
    const bundle = await session.exportEvidence(job.jobId);
    expect(bundle.job.status).toBe("EXPIRED");
    expect(bundle.balanceDeltas.provider).toBe("0");
    expect(bundle.balanceDeltas.buyer).toBe("0");
    expect(verifyBundle(bundle).lines.filter((l) => !l.ok)).toEqual([]);
    expect((await verifyAgainstChain("expired", bundle)).exit).toBe(0);
  });

  it("an unrelated mint and transfer do not appear in a job's record", async () => {
    const job = await completedJob(600n, "Untouched job");
    const before = await session.exportEvidence(job);

    const token = session.dep.token as any;
    await (await token.mint(session.chain.addresses.thirdParty, parseUnits("500", 6))).wait();
    await (await (token.connect(session.chain.wallets.thirdParty) as any)
      .transfer(session.chain.addresses.provider, parseUnits("7", 6))).wait();

    const after = await session.exportEvidence(job);
    expect(after.balanceDeltas).toEqual(before.balanceDeltas);
    expect(verifyBundle(after).lines.filter((l) => !l.ok)).toEqual([]);
  });

  it("the combined submit-and-settle receipt is counted once", async () => {
    const job = await completedJob(700n, "Combined receipt");
    const bundle = await session.exportEvidence(job);
    const hashes = bundle.transactions.map((t) => t.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    // One funding movement in, one payout movement out. Not two of either.
    expect(bundle.observedTransfers.transfers.filter((t) => t.direction === "in")).toHaveLength(1);
    expect(bundle.observedTransfers.transfers.filter((t) => t.direction === "out")).toHaveLength(1);
    expect(bundle.balanceDeltas.provider).toBe(AMOUNT);
  });

  it("current wallet balances are reported separately and are not the job's result", async () => {
    const job = await completedJob(800n, "Separate views");
    const bundle = await session.exportEvidence(job);
    expect(bundle.currentWalletBalances).toBeDefined();
    // Many jobs have run by now, so the wallet totals differ from this job's movements.
    expect(BigInt(bundle.currentWalletBalances.provider ?? "0")).toBeGreaterThan(BigInt(AMOUNT));
    expect(bundle.balanceDeltas.provider).toBe(AMOUNT);
  });
});

describe("R2 — recorded timestamps must match the stored job", () => {
  let session: Session;
  let dir: string;
  let paid: EvidenceBundle;
  let rejected: EvidenceBundle;
  let expired: EvidenceBundle;

  beforeAll(async () => {
    session = await Session.start();
    dir = mkdtempSync(join(tmpdir(), "acceptance-r2-"));

    const a = await session.createJobFromRows(batch(0n), "Paid");
    await session.runAutomaticForJob(a.jobId);
    paid = await session.exportEvidence(a.jobId);

    const b = await session.createJobFromRows(batch(100n), "Rejected");
    await session.accept(b.jobId); await session.fund(b.jobId);
    await session.submitAndSettle(b.jobId, "price");
    rejected = await session.exportEvidence(b.jobId);

    const c = await session.createJobFromRows(batch(200n), "Expired");
    await session.accept(c.jobId); await session.fund(c.jobId);
    await session.advanceTime(8000);
    await session.refundExpired(c.jobId);
    expired = await session.exportEvidence(c.jobId);
  }, 180_000);
  afterAll(async () => { await session?.close(); });

  async function verifyAgainstChain(label: string, bundle: EvidenceBundle) {
    const file = join(dir, `${label}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    const r = await runCli([file, "--rpc", session.chain.rpcUrl]);
    return { exit: r.code, claimsVerified: r.stdout.includes("on-chain settlement verified"), stdout: r.stdout };
  }

  it("valid paid, rejected and expired bundles all verify (controls)", async () => {
    for (const [label, b] of [["paid", paid], ["rejected", rejected], ["expired", expired]] as const) {
      const r = await verifyAgainstChain(`control-${label}`, b);
      expect(r.exit, `${label}: ${r.stdout}`).toBe(0);
      expect(r.claimsVerified).toBe(true);
    }
  });

  it("an expired job with no submission carries an unset submission time", () => {
    expect(expired.job.submittedAt).toBe(0);
    expect(expired.job.settledAt).toBeGreaterThan(0);
    expect(verifyBundle(expired).lines.filter((l) => !l.ok)).toEqual([]);
  });

  it("rejects a submission time moved past the settlement deadline", async () => {
    const forged = structuredClone(paid);
    forged.job.submittedAt = forged.job.settlementExpiry + 86_400;
    forged.job.settledAt = forged.job.submittedAt + 3_600;
    const r = await verifyAgainstChain("late-timestamps", forged);
    expect(r.claimsVerified, "an impossible timeline was reported as verified").toBe(false);
    expect(r.exit).not.toBe(0);
  });

  it("rejects each timestamp mutated on its own, including plausible earlier ones", async () => {
    const mutations: [string, (b: EvidenceBundle) => void][] = [
      ["createdAt-earlier", (b) => { b.job.createdAt -= 60; }],
      ["submittedAt-earlier", (b) => { b.job.submittedAt -= 1; }],
      ["submittedAt-later", (b) => { b.job.submittedAt += 5; }],
      ["settledAt-earlier", (b) => { b.job.settledAt -= 1; }],
      ["settledAt-later", (b) => { b.job.settledAt += 5; }],
    ];
    for (const [label, mutate] of mutations) {
      const forged = structuredClone(paid);
      mutate(forged);
      const r = await verifyAgainstChain(label, forged);
      expect(r.claimsVerified, `${label} was accepted`).toBe(false);
      expect(r.exit, `${label} exited 0`).not.toBe(0);
    }
  });

  it("rejects a claimed submission on a job that never had one", async () => {
    const forged = structuredClone(expired);
    forged.job.submittedAt = forged.job.createdAt + 10;
    const r = await verifyAgainstChain("phantom-submission", forged);
    expect(r.claimsVerified).toBe(false);
  });

  it("offline consistency rejects an impossible ordering without needing a chain", () => {
    const forged = structuredClone(paid);
    forged.job.settledAt = forged.job.createdAt - 1;
    const v = verifyBundle(forged);
    expect(v.ok).toBe(false);
    expect(v.lines.filter((l) => !l.ok).map((l) => l.name).join(" ")).toMatch(/timestamp/i);
  });
});
