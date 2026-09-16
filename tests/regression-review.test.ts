/**
 * Regression tests for the five findings in the independent review of 14 September 2026.
 *
 * Every test here reproduces a behaviour the review demonstrated, and asserts the corrected
 * behaviour. Each one failed before the corresponding repair. They are deliberately written
 * against the same surfaces the review used — the real provider process, the real escrow, the
 * real verifier CLI — rather than against internal helpers, because the review's point was that
 * the internals agreed with themselves while the boundary did not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { connect } from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import * as jobs from "../src/chain/jobs.ts";
import { loadFixture, PROJECT_ROOT } from "../src/chain/fixtures.ts";
import { buildPack, coverage } from "../src/shared/pack.ts";
import { transform } from "../src/agents/common.ts";
import { verifyBundle, type EvidenceBundle } from "../src/shared/evidence.ts";
import { AMOUNT, expectRevert, harness, makeJob, payment, type Harness } from "./helpers.ts";

const TSX = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(script: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [TSX, join(PROJECT_ROOT, script), ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("P1 — the provider must validate the agreement's meaning, not only its fingerprints", () => {
  let h: Harness;
  let dir: string;
  let runtimePath: string;

  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "acceptance-regression-"));
    runtimePath = join(dir, "runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      rpcUrl: h.chain.rpcUrl, chainId: h.chain.chainId,
      addresses: h.dep.addresses, roles: h.chain.addresses, startedAt: new Date().toISOString(),
    }));
  });
  afterAll(async () => { await h?.close(); });

  /** Runs the real provider program exactly as the orchestrator does. */
  async function providerAccepts(job: { jobId: bigint; pack: unknown }, label: string) {
    const packPath = join(dir, `${label}.json`);
    writeFileSync(packPath, JSON.stringify(job.pack));
    const r = await runCli(
      "src/agents/provider.ts",
      ["accept", "--job", String(job.jobId), "--runtime", runtimePath, "--pack", packPath],
      { PROVIDER_KEY: h.chain.wallets.provider.privateKey },
    );
    return { ...r, status: (await jobs.readJob(h.dep.escrow, job.jobId)).status };
  }

  it("refuses a pack carrying a clause software cannot check, even when the buyer claimed a count of zero", async () => {
    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({
      title: "Unsupported scope", source, payment: payment(), includeSubjectiveClause: true,
    });
    expect(coverage(pack).fullyAutomatic).toBe(false);

    // The buyer lies to the contract about the count, so creation succeeds.
    const job = await makeJob(h, { pack, unsupportedClauseCountOverrideForNegativeTests: 0 });

    const r = await providerAccepts(job, "unsupported-pack");
    expect(r.status).toBe("CREATED");
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/PACK_NOT_FULLY_AUTOMATIC|UNSUPPORTED/i);
  });

  it("refuses a pack advertising an amount the on-chain terms do not match", async () => {
    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({ title: "Advertises 25", source, payment: payment() });
    const job = await makeJob(h, { pack, amount: 1_000_000n });

    const r = await providerAccepts(job, "amount-mismatch");
    expect(r.status).toBe("CREATED");
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/AMOUNT/i);
  });

  it("refuses a pack that names a different source batch from the one stored on chain", async () => {
    const source = loadFixture("source-batch-1.json");
    const otherSource = source.map((r, i) => ({ ...r, priceCents: r.priceCents + (i === 0 ? 1n : 0n) }));
    const pack = buildPack({ title: "Names another batch", source: otherSource, payment: payment() });
    const job = await makeJob(h, { pack, source });

    const r = await providerAccepts(job, "source-mismatch");
    expect(r.status).toBe("CREATED");
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/SOURCE_DIGEST/i);
  });

  it("refuses arbitrary prose labelled EXECUTABLE that has no corresponding check", async () => {
    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({ title: "Invented clause", source, payment: payment() });
    pack.clauses[3] = {
      ...pack.clauses[3]!,
      text: "Rows are sorted in whatever order the provider judges most useful.",
    };
    const job = await makeJob(h, { pack });

    const r = await providerAccepts(job, "invented-clause");
    expect(r.status).toBe("CREATED");
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/CLAUSE_TEXT|TEMPLATE/i);
  });

  it("still accepts a well-formed agreement", async () => {
    const source = loadFixture("source-batch-1.json");
    const pack = buildPack({ title: "Good", source, payment: payment() });
    const job = await makeJob(h, { pack });

    const r = await providerAccepts(job, "good");
    expect(r.code, r.stderr).toBe(0);
    expect(r.status).toBe("ACCEPTED");
  });
});

describe("P1 — the escrow must only accept its approved payment token", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  it("refuses a payment-token address with no contract code", async () => {
    const eoa = h.chain.addresses.thirdParty;
    expect(await h.chain.provider.getCode(eoa)).toBe("0x");

    const source = loadFixture("source-batch-1.json");
    const err = await expectRevert(
      () => jobs.createJob({
        escrow: h.dep.escrow, buyer: h.chain.wallets.buyer, provider: h.chain.addresses.provider,
        token: eoa, amount: AMOUNT, source,
        pack: buildPack({ title: "EOA token", source, payment: payment() }),
        deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
      }),
      h.dep.escrow,
    );
    expect(err.name).toBe("UnsupportedPaymentToken");
  });

  it("refuses any token other than the one the escrow was deployed with", async () => {
    const source = loadFixture("source-batch-1.json");
    const { ContractFactory } = await import("ethers");
    const art = h.chain.artifacts.contracts["MockUSD"]!;
    const other = await new ContractFactory(art.abi, art.bytecode, h.chain.wallets.deployer).deploy();
    await other.waitForDeployment();
    const otherAddress = await other.getAddress();
    expect(await h.chain.provider.getCode(otherAddress)).not.toBe("0x");

    const err = await expectRevert(
      () => jobs.createJob({
        escrow: h.dep.escrow, buyer: h.chain.wallets.buyer, provider: h.chain.addresses.provider,
        token: otherAddress, amount: AMOUNT, source,
        pack: buildPack({ title: "Other token", source, payment: payment() }),
        deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
      }),
      h.dep.escrow,
    );
    expect(err.name).toBe("UnsupportedPaymentToken");
  });

  it("exposes the approved token so a client can check it before agreeing", async () => {
    expect(await (h.dep.escrow as any).paymentToken()).toBe(h.dep.addresses.token);
  });
});

describe("P1 — evidence must verify the payment it claims", () => {
  let h: Harness;
  let dir: string;
  let bundle: EvidenceBundle;

  beforeAll(async () => {
    const { Session } = await import("../src/chain/session.ts");
    const session = await Session.start();
    const job = await session.createJob("pass");
    await session.accept(job.jobId);
    await session.fund(job.jobId);
    await session.submit(job.jobId);
    await session.settle(job.jobId);
    bundle = await session.exportEvidence(job.jobId);
    dir = mkdtempSync(join(tmpdir(), "acceptance-evidence-"));
    h = { chain: session.chain, dep: session.dep, close: () => session.close() } as Harness;
  }, 180_000);
  afterAll(async () => { await h?.close(); });

  it("the untampered bundle verifies, offline and against the chain", async () => {
    const r = verifyBundle(bundle);
    expect(r.lines.filter((l) => !l.ok)).toEqual([]);
    const path = join(dir, "good.json");
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    const cli = await runCli("scripts/verify-bundle.ts", [path, "--rpc", h.chain.rpcUrl]);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toMatch(/on-chain settlement verified/i);
  });

  it("rejects a bundle whose displayed recipient, amount or status contradicts its own terms", () => {
    const forged = structuredClone(bundle);
    forged.job.provider = "0x000000000000000000000000000000000000dEaD";
    forged.job.amountBaseUnits = "999000000";
    forged.job.status = "REJECTED";
    const r = verifyBundle(forged);
    expect(r.ok).toBe(false);
    const section = r.sections.find((x) => x.key === "internallyConsistent")!;
    expect(section.verdict).toBe("FAIL");
    const failed = section.lines.filter((l) => !l.ok).map((l) => l.name);
    expect(failed).toContain("displayed provider matches the terms");
    expect(failed).toContain("displayed amount matches the terms");
    expect(failed).toContain("displayed status matches the recorded verdict");
  });

  it("rejects each contradiction on its own", () => {
    for (const mutate of [
      (b: EvidenceBundle) => { b.job.provider = "0x000000000000000000000000000000000000dEaD"; },
      (b: EvidenceBundle) => { b.job.amountBaseUnits = "999000000"; },
      (b: EvidenceBundle) => { b.job.status = "REJECTED"; },
      (b: EvidenceBundle) => { b.job.buyer = "0x000000000000000000000000000000000000bEEF"; },
      (b: EvidenceBundle) => { b.job.jobId = "9999"; },
      (b: EvidenceBundle) => { b.chain.chainId = 8453; },
      (b: EvidenceBundle) => { b.chain.escrow = "0x000000000000000000000000000000000000bEEF"; },
      (b: EvidenceBundle) => { b.recordedVerdict.verdictName = "FAIL"; },
      (b: EvidenceBundle) => { b.balanceDeltas.provider = "1"; },
    ]) {
      const forged = structuredClone(bundle);
      mutate(forged);
      expect(verifyBundle(forged).ok, `mutation not caught: ${mutate.toString()}`).toBe(false);
    }
  });

  it("rejects an unrelated token-mint receipt presented as settlement evidence", async () => {
    const mint = await (await (h.dep.token as any).mint(h.chain.addresses.buyer, 1n)).wait();
    const forged = structuredClone(bundle);
    forged.transactions = [{ step: "settle", ...jobs.txInfo(mint) }];
    const path = join(dir, "unrelated-receipt.json");
    writeFileSync(path, JSON.stringify(forged, null, 2));

    const cli = await runCli("scripts/verify-bundle.ts", [path, "--rpc", h.chain.rpcUrl]);
    expect(cli.code).not.toBe(0);
    expect(cli.stdout).not.toMatch(/Bundle verified\./);
  });

  it("rejects an empty receipt set presented as settlement evidence", async () => {
    const forged = structuredClone(bundle);
    forged.transactions = [];
    const path = join(dir, "no-receipts.json");
    writeFileSync(path, JSON.stringify(forged, null, 2));
    const cli = await runCli("scripts/verify-bundle.ts", [path, "--rpc", h.chain.rpcUrl]);
    expect(cli.code).not.toBe(0);
  });

  it("reports the three questions separately instead of one reassuring success", async () => {
    const path = join(dir, "good2.json");
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    const offline = await runCli("scripts/verify-bundle.ts", [path]);
    expect(offline.stdout).toMatch(/rules reproduced/i);
    expect(offline.stdout).toMatch(/bundle internally consistent/i);
    expect(offline.stdout).toMatch(/on-chain settlement/i);
    // Without --rpc the settlement question must be reported as NOT CHECKED, never as passed.
    expect(offline.stdout).toMatch(/not checked/i);
    expect(offline.stdout).not.toMatch(/on-chain settlement verified/i);
  });
});

describe("P2 — every development listener binds to loopback only", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h?.close(); });

  const externalIPv4 = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  it("the local chain refuses connections on a non-loopback address of this machine", async () => {
    if (!externalIPv4) {
      console.warn("      (no non-loopback IPv4 on this machine; binding asserted via lsof only)");
      return;
    }
    const port = Number(new URL(h.chain.rpcUrl).port);
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: externalIPv4, port, timeout: 3000 });
      socket.on("connect", () => { socket.destroy(); resolve("CONNECTED"); });
      socket.on("timeout", () => { socket.destroy(); resolve("TIMEOUT"); });
      socket.on("error", (e: any) => { socket.destroy(); resolve(e.code ?? "ERROR"); });
    });
    expect(outcome, `the chain accepted a connection on ${externalIPv4}`).not.toBe("CONNECTED");
  });

  it("the chain still works on loopback", async () => {
    expect(new URL(h.chain.rpcUrl).hostname).toBe("127.0.0.1");
    expect(await h.chain.provider.getBlockNumber()).toBeGreaterThanOrEqual(0);
  });

  it("lsof shows a loopback-scoped listener, not a wildcard one", async () => {
    const port = Number(new URL(h.chain.rpcUrl).port);
    let stdout = "";
    try {
      ({ stdout } = await promisify(execFile)("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]));
    } catch {
      console.warn("      (lsof unavailable; skipped)");
      return;
    }
    expect(stdout).toMatch(/127\.0\.0\.1:/);
    expect(stdout, `wildcard listener found:\n${stdout}`).not.toMatch(/\*:\d+/);
  });
});

describe("P2 — concurrent sessions do not share runtime metadata or evidence", () => {
  it("two simultaneous sessions keep separate runtime files, chains and evidence directories", async () => {
    const { Session } = await import("../src/chain/session.ts");
    const a = await Session.start();
    const b = await Session.start();
    try {
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.runtimePath).not.toBe(b.runtimePath);
      expect(a.evidenceDir).not.toBe(b.evidenceDir);
      expect(existsSync(a.runtimePath)).toBe(true);
      expect(existsSync(b.runtimePath)).toBe(true);

      const ra = JSON.parse(readFileSync(a.runtimePath, "utf8"));
      const rb = JSON.parse(readFileSync(b.runtimePath, "utf8"));
      expect(ra.rpcUrl).not.toBe(rb.rpcUrl);
      expect(ra.addresses.escrow).toBe(a.dep.addresses.escrow);
      expect(rb.addresses.escrow).toBe(b.dep.addresses.escrow);

      // Each session's agents reach that session's own chain.
      const ja = await a.runAgents("pass");
      const jb = await b.runAgents("fail-order");
      expect((await a.readJob(ja.jobId)).status).toBe("PAID");
      expect((await b.readJob(jb.jobId)).status).toBe("REJECTED");
    } finally {
      await a.close();
      await b.close();
    }
  }, 240_000);

  it("a session keeps working after another session has started and stopped", async () => {
    const { Session } = await import("../src/chain/session.ts");
    const live = await Session.start();
    try {
      const transient = await Session.start();
      await transient.runAgents("pass");
      await transient.close();

      // The transient session must not have redirected the live one's agents.
      const job = await live.runAgents("pass");
      expect((await live.readJob(job.jobId)).status).toBe("PAID");
      expect(JSON.parse(readFileSync(live.runtimePath, "utf8")).addresses.escrow)
        .toBe(live.dep.addresses.escrow);
    } finally {
      await live.close();
    }
  }, 240_000);

  it("agents refuse to run without an explicit runtime path", async () => {
    const r = await runCli("src/agents/buyer.ts", ["fund", "--job", "1"], { BUYER_KEY: "0x" + "11".repeat(32) });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--runtime/);
  });
});
