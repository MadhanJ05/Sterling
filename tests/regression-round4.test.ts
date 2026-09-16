/**
 * Regression tests for the fourth independent review, 14 September 2026.
 *
 * One finding: the offline verifier recomputed net balance changes from the movement list, and
 * separately compared the supplied `fundedIn`/`paidOut`/`paidTo` summaries with the agreement —
 * but never checked that those summaries came from that movement list. A bundle could therefore
 * carry no movements at all, or half-size ones, and still claim a full payment.
 *
 * Every mutation here is a contradiction *within the bundle*. Catching them must not require a
 * chain, so the offline checker and the offline CLI are both asserted. The RPC checks are asserted
 * too, to prove they were not weakened while closing the offline gap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/chain/session.ts";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";
import { verifyBundle, type EvidenceBundle } from "../src/shared/evidence.ts";

const TSX = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const AMOUNT = 25_000_000n;

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

describe("R4 — transfer summaries must be reconciled with the movements they claim to summarise", () => {
  let session: Session;
  let dir: string;
  let paid: EvidenceBundle;
  let rejected: EvidenceBundle;
  let expired: EvidenceBundle;

  beforeAll(async () => {
    session = await Session.start();
    dir = mkdtempSync(join(tmpdir(), "acceptance-r4-"));

    const a = await session.runAutomatic("pass");
    paid = await session.exportEvidence(a.jobId);

    const b = await session.createJob("fail-price");
    await session.accept(b.jobId); await session.fund(b.jobId);
    await session.submitAndSettle(b.jobId);
    rejected = await session.exportEvidence(b.jobId);

    const c = await session.createJob("expiry");
    await session.accept(c.jobId); await session.fund(c.jobId);
    await session.advanceTime(200);
    await session.refundExpired(c.jobId);
    expired = await session.exportEvidence(c.jobId);
  }, 180_000);
  afterAll(async () => { await session?.close(); });

  const offlineCli = async (label: string, bundle: EvidenceBundle) => {
    const file = join(dir, `${label}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    return runCli([file]);
  };
  const rpcCli = async (label: string, bundle: EvidenceBundle) => {
    const file = join(dir, `${label}-rpc.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    const r = await runCli([file, "--rpc", session.chain.rpcUrl]);
    return { ...r, claimsVerified: r.stdout.includes("on-chain settlement verified") };
  };

  /** Asserts a mutation is caught offline, by both the library and the CLI, and still by RPC. */
  async function expectRejected(label: string, mutate: (b: EvidenceBundle) => void, base = paid) {
    const forged = structuredClone(base);
    mutate(forged);
    const v = verifyBundle(forged);
    expect(v.ok, `${label}: offline checker accepted it`).toBe(false);
    const cli = await offlineCli(label, forged);
    expect(cli.code, `${label}: offline CLI exited 0`).not.toBe(0);
    const rpc = await rpcCli(label, forged);
    expect(rpc.claimsVerified, `${label}: RPC claimed verification`).toBe(false);
    expect(rpc.code).not.toBe(0);
    return v;
  }

  // ---------------------------------------------------------------- controls

  it("genuine paid, rejected and expired bundles pass offline and against the chain", async () => {
    for (const [label, b] of [["paid", paid], ["rejected", rejected], ["expired", expired]] as const) {
      const v = verifyBundle(b);
      expect(v.lines.filter((l) => !l.ok), label).toEqual([]);
      const cli = await offlineCli(`control-${label}`, b);
      expect(cli.code, `${label}: ${cli.stdout}`).toBe(0);
      expect(cli.stdout).toMatch(/on-chain settlement: not checked|NOT CHECKED/i);
      const rpc = await rpcCli(`control-${label}`, b);
      expect(rpc.code, `${label} rpc: ${rpc.stdout}`).toBe(0);
      expect(rpc.claimsVerified).toBe(true);
    }
  });

  // -------------------------------------------------- the review's two cases

  it("rejects an empty movement list whose summaries still claim a full payment", async () => {
    const v = await expectRejected("empty-movements", (b) => {
      b.observedTransfers.transfers = [];
      for (const role of Object.keys(b.balanceDeltas)) b.balanceDeltas[role] = "0";
      // fundedIn / paidOut / paidTo left claiming the full 25,000,000.
    });
    expect(v.lines.filter((l) => !l.ok).map((l) => l.name).join(" ")).toMatch(/summar|movement/i);
  });

  it("rejects half-size movements whose summaries still claim a full payment", async () => {
    await expectRejected("half-movements", (b) => {
      for (const t of b.observedTransfers.transfers) t.value = (BigInt(t.value) / 2n).toString();
      for (const role of Object.keys(b.balanceDeltas)) {
        b.balanceDeltas[role] = (BigInt(b.balanceDeltas[role]!) / 2n).toString();
      }
    });
  });

  // ------------------------------------------------- the rest of the surface

  it("rejects a summary naming a recipient the movements do not show", async () => {
    await expectRejected("wrong-paid-to", (b) => {
      b.observedTransfers.paidTo = b.job.buyer; // the movements show the provider
    });
  });

  it("rejects a supplied direction that contradicts the addresses", async () => {
    await expectRejected("contradictory-direction", (b) => {
      const out = b.observedTransfers.transfers.find((t) => t.direction === "out")!;
      out.direction = "in";
    });
  });

  it("rejects duplicated movement identifiers", async () => {
    await expectRejected("duplicated-movement", (b) => {
      const first = b.observedTransfers.transfers[0]!;
      b.observedTransfers.transfers.push({ ...first });
      // Keep the deltas consistent with the doubled list, so only the duplication is wrong.
      for (const role of ["buyer", "provider", "escrow"] as const) {
        const sign = first.from.toLowerCase() === (role === "escrow" ? b.chain.escrow : (b.job as any)[role === "provider" ? "provider" : "buyer"]).toLowerCase() ? -1n : 0n;
        void sign;
      }
    });
  });

  it("rejects a summary that inflates fundedIn beyond the movements", async () => {
    await expectRejected("inflated-funded-in", (b) => {
      b.observedTransfers.fundedIn = (AMOUNT * 2n).toString();
    });
  });

  it("rejects a summary that understates paidOut", async () => {
    await expectRejected("understated-paid-out", (b) => {
      b.observedTransfers.paidOut = "1";
    });
  });

  it("rejects a terminal paid job with no outbound movement at all", async () => {
    await expectRejected("no-payout-movement", (b) => {
      b.observedTransfers.transfers = b.observedTransfers.transfers.filter((t) => t.direction === "in");
      b.observedTransfers.paidOut = "0";
      b.observedTransfers.paidTo = null;
      b.balanceDeltas.provider = "0";
      b.balanceDeltas.escrow = AMOUNT.toString();
    });
  });

  it("rejects a terminal paid job with no funding movement at all", async () => {
    await expectRejected("no-funding-movement", (b) => {
      b.observedTransfers.transfers = b.observedTransfers.transfers.filter((t) => t.direction === "out");
      b.observedTransfers.fundedIn = "0";
      b.balanceDeltas.buyer = "0";
      b.balanceDeltas.escrow = (-AMOUNT).toString();
    });
  });

  it("rejects a refunded job whose movements show the provider being paid", async () => {
    await expectRejected("refund-paid-to-provider", (b) => {
      const out = b.observedTransfers.transfers.find((t) => t.direction === "out")!;
      out.to = b.job.provider;
      b.observedTransfers.paidTo = b.job.provider;
      b.balanceDeltas.provider = AMOUNT.toString();
      b.balanceDeltas.buyer = (-AMOUNT).toString();
    }, rejected);
  });

  it("the exporter's own summaries are exactly what its movements derive to", () => {
    for (const b of [paid, rejected, expired]) {
      const o = b.observedTransfers;
      const inSum = o.transfers.filter((t) => t.direction === "in").reduce((a, t) => a + BigInt(t.value), 0n);
      const outSum = o.transfers.filter((t) => t.direction === "out").reduce((a, t) => a + BigInt(t.value), 0n);
      expect(BigInt(o.fundedIn)).toBe(inSum);
      expect(BigInt(o.paidOut)).toBe(outSum);
      expect(inSum).toBe(AMOUNT);
      expect(outSum).toBe(AMOUNT);
    }
  });
});
