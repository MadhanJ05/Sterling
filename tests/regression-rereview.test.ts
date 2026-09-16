/**
 * Regression tests for the second independent review, 14 September 2026.
 *
 * Findings F1–F5. Each test reproduces a behaviour the review demonstrated and asserts the
 * corrected behaviour; each failed before the corresponding repair. The forged-evidence tests
 * follow the review's requirement explicitly: rewrite BOTH copies of a field and every dependent
 * hash, keep the genuine receipts, and still expect rejection. Single-field mutations that merely
 * contradict another copy in the same bundle live in tests/regression-review.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContractFactory, parseUnits } from "ethers";
import { Session } from "../src/chain/session.ts";
import * as jobs from "../src/chain/jobs.ts";
import { PROJECT_ROOT, loadFixture } from "../src/chain/fixtures.ts";
import { canonicalDigest, termsDigest } from "../src/shared/encoding.ts";
import { buildPack, packDigest, coverage } from "../src/shared/pack.ts";
import { rowsIn, deserializeTerms, type EvidenceBundle } from "../src/shared/evidence.ts";
import type { RecordRow } from "../src/shared/types.ts";

const TSX = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(script: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [TSX, join(PROJECT_ROOT, script), ...args], {
      cwd: PROJECT_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------- F1

describe("F1 — genuine receipts must not authenticate a fabricated agreement", () => {
  let session: Session;
  let good: EvidenceBundle;
  let dir: string;

  beforeAll(async () => {
    session = await Session.start();
    const job = await session.createJob("pass");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submitAndSettle(job.jobId);
    good = await session.exportEvidence(job.jobId);
    dir = mkdtempSync(join(tmpdir(), "acceptance-forge-"));
  }, 180_000);
  afterAll(async () => { await session?.close(); });

  /** Runs the real CLI against the live chain the bundle names. */
  async function verifyAgainstChain(label: string, bundle: EvidenceBundle) {
    const file = join(dir, `${label}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    const r = await runCli("scripts/verify-bundle.ts", [file, "--rpc", session.chain.rpcUrl]);
    return {
      exit: r.code,
      claimsVerified: r.stdout.includes("on-chain settlement verified"),
      stdout: r.stdout,
    };
  }

  it("accepts the genuine bundle (control)", async () => {
    const r = await verifyAgainstChain("control", good);
    expect(r.exit, r.stdout).toBe(0);
    expect(r.claimsVerified).toBe(true);
  });

  it("rejects a bundle whose source and delivery were both rewritten with every hash recomputed", async () => {
    const forged = structuredClone(good);
    for (const r of forged.source) r.priceCents = (BigInt(r.priceCents) + 777n).toString();
    for (const r of forged.delivery!) r.priceCents = (BigInt(r.priceCents) + 777n).toString();
    forged.pack.sourceDigest = canonicalDigest(rowsIn(forged.source));
    forged.terms.sourceDigest = forged.commitments.sourceDigest = forged.pack.sourceDigest;
    forged.terms.packDigest = forged.commitments.packDigest = packDigest(forged.pack);
    forged.commitments.deliveryDigest = canonicalDigest(rowsIn(forged.delivery!));
    forged.commitments.termsDigest = termsDigest(deserializeTerms(forged.terms));

    // The forgery is internally perfect: offline checks alone cannot catch it.
    const { verifyBundle } = await import("../src/shared/evidence.ts");
    expect(verifyBundle(forged).ok, "the forgery should be internally consistent").toBe(true);

    const r = await verifyAgainstChain("rewritten-files", forged);
    expect(r.claimsVerified, "a fabricated agreement was authenticated by genuine receipts").toBe(false);
    expect(r.exit).not.toBe(0);
    expect(r.stdout).toMatch(/terms digest|source commitment|delivery commitment/i);
  });

  it("rejects a bundle whose buyer was rewritten in both the display and the terms", async () => {
    const forged = structuredClone(good);
    forged.terms.buyer = forged.job.buyer = session.chain.addresses.thirdParty;
    forged.commitments.termsDigest = termsDigest(deserializeTerms(forged.terms));
    const r = await verifyAgainstChain("rewritten-buyer", forged);
    expect(r.claimsVerified).toBe(false);
    expect(r.exit).not.toBe(0);
  });

  it("rejects a bundle whose deadlines were rewritten consistently", async () => {
    const forged = structuredClone(good);
    forged.terms.settlementExpiry = String(Number(forged.terms.settlementExpiry) + 86_400);
    forged.job.settlementExpiry = Number(forged.terms.settlementExpiry);
    forged.commitments.termsDigest = termsDigest(deserializeTerms(forged.terms));
    const r = await verifyAgainstChain("rewritten-deadlines", forged);
    expect(r.claimsVerified).toBe(false);
    expect(r.exit).not.toBe(0);
  });

  it("rejects a bundle whose pack was rewritten consistently", async () => {
    const forged = structuredClone(good);
    forged.pack.title = "A different agreement entirely";
    forged.terms.packDigest = forged.commitments.packDigest = packDigest(forged.pack);
    forged.commitments.termsDigest = termsDigest(deserializeTerms(forged.terms));
    const r = await verifyAgainstChain("rewritten-pack", forged);
    expect(r.claimsVerified).toBe(false);
    expect(r.exit).not.toBe(0);
  });

  it("rejects a bundle whose source and delivery were swapped for another job's", async () => {
    // Genuinely different data, or the "swap" would be a no-op: both built-in `pass` jobs share a
    // fixture, so grafting one onto the other changes nothing.
    const other = await session.createJobFromRows(
      [{ productId: 5001n, priceCents: 111n }, { productId: 5002n, priceCents: 222n }],
      "A different batch entirely",
    );
    await session.accept(other.jobId);
    await session.fund(other.jobId);
    await session.submitAndSettle(other.jobId);
    const otherBundle = await session.exportEvidence(other.jobId);
    expect(otherBundle.commitments.sourceDigest).not.toBe(good.commitments.sourceDigest);

    // Keep job 1's identity and receipts, but present job 2's data as its content.
    const forged = structuredClone(good);
    forged.source = otherBundle.source;
    forged.delivery = otherBundle.delivery;
    forged.pack = otherBundle.pack;
    forged.terms.sourceDigest = forged.commitments.sourceDigest = canonicalDigest(rowsIn(forged.source));
    forged.terms.packDigest = forged.commitments.packDigest = packDigest(forged.pack);
    forged.commitments.deliveryDigest = canonicalDigest(rowsIn(forged.delivery!));
    forged.commitments.termsDigest = termsDigest(deserializeTerms(forged.terms));

    const r = await verifyAgainstChain("swapped-data", forged);
    expect(r.claimsVerified).toBe(false);
  });

  it("checks the token transfer on the expiry-refund branch too", async () => {
    const job = await session.createJob("expiry");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.advanceTime(200);
    await session.refundExpired(job.jobId);
    const bundle = await session.exportEvidence(job.jobId);

    const r = await verifyAgainstChain("expired-control", bundle);
    expect(r.exit, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/refund token actually moved|payment token actually moved/i);
  });
});

// ---------------------------------------------------------------------------- F2

describe("F2 — an imported batch must complete through the normal path", () => {
  let session: Session;
  beforeAll(async () => { session = await Session.start(); }, 180_000);
  afterAll(async () => { await session?.close(); });

  const rows: RecordRow[] = [
    { productId: 903n, priceCents: 199n },
    { productId: 901n, priceCents: 249n },
    { productId: 902n, priceCents: 359n },
  ];

  it("delivers and settles an imported batch through submitAndSettle", async () => {
    const job = await session.createJobFromRows(rows, "Independent imported batch");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submitAndSettle(job.jobId);

    const onChain = await session.readJob(job.jobId);
    expect(onChain.status).toBe("PAID");
    expect(onChain.output.map((r) => r.productId)).toEqual([901n, 902n, 903n]);

    const bundle = await session.exportEvidence(job.jobId);
    const { verifyBundle } = await import("../src/shared/evidence.ts");
    const v = verifyBundle(bundle);
    expect(v.lines.filter((l) => !l.ok)).toEqual([]);
  });

  it("delivers and settles an imported batch through the two-step path", async () => {
    const job = await session.createJobFromRows(
      rows.map((r) => ({ ...r, productId: r.productId + 100n })), "Imported batch, two-step",
    );
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submit(job.jobId);
    expect((await session.readJob(job.jobId)).status).toBe("SUBMITTED");
    await session.settle(job.jobId);
    expect((await session.readJob(job.jobId)).status).toBe("PAID");
  });

  it("runs an imported batch through the same automatic path as the built-in example", async () => {
    const job = await session.createJobFromRows(
      rows.map((r) => ({ ...r, productId: r.productId + 200n })), "Imported batch, automatic",
    );
    const finished = await session.runAutomaticForJob(job.jobId);
    expect((await session.readJob(finished.jobId)).status).toBe("PAID");
  });

  it("still produces a deliberate failure when a defect is requested explicitly", async () => {
    const job = await session.createJobFromRows(
      rows.map((r) => ({ ...r, productId: r.productId + 300n })), "Imported batch, deliberate defect",
    );
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submitAndSettle(job.jobId, "order");
    const onChain = await session.readJob(job.jobId);
    expect(onChain.status).toBe("REJECTED");
    expect(onChain.ruleId).toBe(4);
  });

  it("every built-in scenario still reaches its documented outcome", async () => {
    const { SCENARIOS } = await import("../src/shared/scenarios.ts");
    for (const sc of SCENARIOS.filter((s) => s.submit)) {
      const job = await session.createJob(sc.id);
      await session.accept(job.jobId);
      await session.fund(job.jobId);
      await session.submitAndSettle(job.jobId);
      const onChain = await session.readJob(job.jobId);
      expect(onChain.status, sc.id).toBe(sc.expectedTerminalStatus);
      expect(onChain.ruleId, sc.id).toBe(sc.expectedRuleId);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------- F3

describe("F3 — automatic execution must not revise unsupported scope by itself", () => {
  let session: Session;
  beforeAll(async () => { session = await Session.start(); }, 180_000);
  afterAll(async () => { await session?.close(); });

  it("refuses an unsupported-scope job, creating nothing and moving nothing", async () => {
    const before = await session.balances();
    const jobsBefore = session.jobsById.size;

    await expect(session.runAutomatic("unsupported-scope")).rejects.toThrow(
      expect.objectContaining({ name: "ScopeRevisionRequired" }),
    );

    expect(await session.balances()).toEqual(before);
    expect(session.jobsById.size).toBe(jobsBefore);
    expect(Number(await (session.dep.escrow as any).jobCount())).toBe(0);
  });

  it("proceeds only when the caller approves the exact revised pack (control)", async () => {
    const preview = session.previewScopeRevision("unsupported-scope");
    expect(preview.revised.packVersion).toBe(2);
    expect(coverage(preview.revised).fullyAutomatic).toBe(true);

    const job = await session.runAutomatic("unsupported-scope", undefined, {
      revision: { approvedPackDigest: preview.revisedPackDigest, reason: preview.reason },
    });
    expect((await session.readJob(job.jobId)).status).toBe("EXPIRED");
    expect(job.pack.clauses.find((c) => c.id === "C5")!.coverage).toBe("EXCLUDED_BY_REVISION");
  });

  it("refuses a revision approval that names a different pack", async () => {
    await expect(session.runAutomatic("unsupported-scope", undefined, {
      revision: { approvedPackDigest: "0x" + "11".repeat(32), reason: "mismatched" },
    })).rejects.toThrow(/approved/i);
  });

  it("an ordinary conforming job still runs with no extra approval", async () => {
    const job = await session.runAutomatic("pass");
    expect((await session.readJob(job.jobId)).status).toBe("PAID");
  });
});

// ---------------------------------------------------------------------------- F4

describe("F4 — the pack's token precision must match the approved asset", () => {
  let session: Session;
  let dir: string;
  beforeAll(async () => {
    session = await Session.start();
    dir = mkdtempSync(join(tmpdir(), "acceptance-decimals-"));
  }, 180_000);
  afterAll(async () => { await session?.close(); });

  it("the provider refuses an agreement that misstates the token's decimals", async () => {
    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({
      title: "Wrong token precision",
      source,
      payment: {
        tokenSymbol: "mUSD", paymentToken: session.dep.addresses.token,
        tokenDecimals: 0, amountBaseUnits: "25000000",
        deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
      },
    });
    const created = await jobs.createJob({
      escrow: session.dep.escrow, buyer: session.chain.wallets.buyer,
      provider: session.chain.addresses.provider, token: session.dep.addresses.token,
      amount: 25_000_000n, source, pack, deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
    });

    const packPath = join(dir, "wrong-decimals.json");
    writeFileSync(packPath, JSON.stringify(pack));
    const r = await runCli(
      "src/agents/provider.ts",
      ["accept", "--runtime", session.runtimePath, "--pack", packPath, "--job", String(created.jobId)],
      { PROVIDER_KEY: session.chain.wallets.provider.privateKey },
    );

    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/DECIMALS/i);
    expect((await jobs.readJob(session.dep.escrow, created.jobId)).status).toBe("CREATED");
  });

  it("the real token reports the decimals the pack must carry", async () => {
    expect(Number(await (session.dep.token as any).decimals())).toBe(6);
    const pack = session.packFor((await import("../src/shared/scenarios.ts")).SCENARIOS[0]!, loadFixture("source-batch-1.json"));
    expect(pack.payment.tokenDecimals).toBe(6);
  });
});

// ---------------------------------------------------------------------------- F5

describe("F5 — a token that credits the recipient less than promised must revert", () => {
  let session: Session;
  beforeAll(async () => { session = await Session.start(); }, 180_000);
  afterAll(async () => { await session?.close(); });

  it("settlement reverts atomically when the recipient receives less than the agreed amount", async () => {
    const art = session.chain.artifacts.contracts["OutgoingFeeToken"]!;
    const fee = await new ContractFactory(art.abi, art.bytecode, session.chain.wallets.deployer).deploy();
    await fee.waitForDeployment();
    const feeAddress = await fee.getAddress();

    const escrowArt = session.chain.artifacts.contracts["AcceptanceEscrow"]!;
    const escrow = await new ContractFactory(escrowArt.abi, escrowArt.bytecode, session.chain.wallets.deployer)
      .deploy(session.dep.addresses.policy, feeAddress);
    await escrow.waitForDeployment();
    const escrowAddress = await escrow.getAddress();

    const amount = parseUnits("25", 6);
    await (await (fee as any).mint(session.chain.addresses.buyer, amount)).wait();

    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({
      title: "Outgoing fee",
      source,
      payment: {
        tokenSymbol: "FEE", paymentToken: feeAddress, tokenDecimals: 6,
        amountBaseUnits: amount.toString(), deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
      },
    });
    const created = await jobs.createJob({
      escrow: escrow as any, buyer: session.chain.wallets.buyer,
      provider: session.chain.addresses.provider, token: feeAddress,
      amount, source, pack, deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
    });
    await jobs.acceptJob(escrow as any, session.chain.wallets.provider, created.jobId, created.termsDigest);
    // Funding credits the escrow in full; only the outgoing leg is short.
    await jobs.fundJob(escrow as any, fee as any, session.chain.wallets.buyer, created.jobId, created.termsDigest, amount);
    expect(BigInt(await (fee as any).balanceOf(escrowAddress))).toBe(amount);

    const output = loadFixture("output-correct.json");
    let reverted = false;
    try {
      await jobs.submitAndSettle(escrow as any, session.chain.wallets.provider, created.jobId, output);
    } catch (e) {
      reverted = true;
      expect(jobs.decodeRevert(escrow as any, e).name).toBe("UnexpectedTokenAmount");
    }
    expect(reverted, "a 10% outgoing fee reached PAID with the provider short-changed").toBe(true);

    // Atomic: nothing recorded, nothing moved, escrow still whole.
    const job = await jobs.readJob(escrow as any, created.jobId);
    expect(job.status).toBe("FUNDED");
    expect(job.output).toEqual([]);
    expect(BigInt(await (fee as any).balanceOf(session.chain.addresses.provider))).toBe(0n);
    expect(BigInt(await (fee as any).balanceOf(escrowAddress))).toBe(amount);
  });
});
