/**
 * One demo session: a disposable chain, the deployed contracts, and the named actions the CLI
 * demo and the web server both drive. Every action is explicit; there is no generic
 * "sign this" entry point anywhere.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseUnits } from "ethers";
import { startLocalChain, deployAll, type Deployment, type LocalChain, type Role } from "./chain.ts";
import { PROJECT_ROOT, loadFixture } from "./fixtures.ts";
import * as jobs from "./jobs.ts";
import { buildPack, coverage, packDigest, rebindToSource, reviseScope, type AcceptancePack } from "../shared/pack.ts";
import { canonicalDigest } from "../shared/encoding.ts";
import { check } from "../shared/policy.ts";
import { SCENARIOS, scenarioById, type FlawKind, type Scenario } from "../shared/scenarios.ts";
import { JobStatus, type RecordRow } from "../shared/types.ts";
import { deriveMovements } from "../shared/transfers.ts";
import { transform } from "../agents/common.ts";
import {
  BUNDLE_CAVEATS, rowsOut, type EvidenceBundle, type EvidenceTx,
  type ObservedTransfer, type ObservedTransfers,
} from "../shared/evidence.ts";

export const DEMO_AMOUNT = parseUnits("25", 6);
export const DEMO_MINT = parseUnits("1000", 6);
export const BUILD_DIR = join(PROJECT_ROOT, "build");
export const SESSIONS_DIR = join(BUILD_DIR, "sessions");
export const EVIDENCE_ROOT = join(PROJECT_ROOT, "evidence");
/** Stable location for the artefacts `npm run demo` produces, so documented paths do not move. */
export const DEMO_EVIDENCE_DIR = join(EVIDENCE_ROOT, "demo");

export interface StepLog {
  step: string;
  who: string;
  detail: string;
  tx?: jobs.TxInfo;
  data?: Record<string, unknown>;
}

export interface SessionJob {
  jobId: string;
  scenarioId: string;
  pack: AcceptancePack;
  packPath: string;
  packDigest: string;
  termsDigest: string;
  source: RecordRow[];
  amount: string;
  steps: StepLog[];
  transactions: EvidenceTx[];
  startBalances: Record<string, string>;
  driver: "ui" | "agents";
}

export const DEFAULT_REVISION_REASON =
  "Descriptions will be reviewed by a person, outside this agreement.";

export interface ScopeRevisionApproval {
  /** Digest of the exact revised pack the caller has read and approved. */
  approvedPackDigest: string;
  reason: string;
}

export interface CreateJobOptions {
  revision?: ScopeRevisionApproval;
}

/** Thrown before anything is created and before any money moves. */
export class ScopeRevisionRequired extends Error {
  constructor(message: string, readonly preview: ReturnType<Session["previewScopeRevision"]>) {
    super(message);
    this.name = "ScopeRevisionRequired";
  }
}

export interface SessionOptions {
  /** Where this session's evidence bundles go. Defaults to a directory named for the session. */
  evidenceDir?: string;
  /** Clear the evidence directory first. Only the demo script asks for this. */
  clearEvidenceDir?: boolean;
}

export class Session {
  readonly jobsById = new Map<string, SessionJob>();
  timeSkewSeconds = 0;
  /** How many times the buyer's valueless test balance has been refilled this session. */
  topUps = 0;

  private constructor(
    readonly chain: LocalChain,
    readonly dep: Deployment,
    /** Unique per running session. Everything this session writes is namespaced by it. */
    readonly sessionId: string,
    readonly sessionDir: string,
    readonly runtimePath: string,
    readonly packsDir: string,
    readonly evidenceDir: string,
  ) {}

  /**
   * Every session gets its own runtime file, pack directory and evidence directory.
   *
   * A single shared `build/runtime.json` meant that starting the test suite or the demo silently
   * repointed a running app's agent subprocesses at a chain that had since been shut down. Nothing
   * is global any more, and `--runtime` is passed explicitly to every child process.
   */
  static async start(opts: SessionOptions = {}): Promise<Session> {
    const chain = await startLocalChain();
    const dep = await deployAll(chain);
    const token = dep.token as any;
    for (const role of ["buyer", "provider", "thirdParty"] as const) {
      await (await token.mint(chain.addresses[role], DEMO_MINT)).wait();
    }

    const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const packsDir = join(sessionDir, "packs");
    const runtimePath = join(sessionDir, "runtime.json");
    const evidenceDir = opts.evidenceDir ?? join(EVIDENCE_ROOT, "sessions", sessionId);

    mkdirSync(packsDir, { recursive: true });
    if (opts.clearEvidenceDir) rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(evidenceDir, { recursive: true });

    writeFileSync(
      runtimePath,
      JSON.stringify(
        {
          sessionId,
          rpcUrl: chain.rpcUrl,
          chainId: chain.chainId,
          addresses: dep.addresses,
          roles: chain.addresses,
          startedAt: new Date().toISOString(),
          note: "Disposable local chain, bound to 127.0.0.1. No private keys are written here or anywhere else on disk.",
        },
        null,
        2,
      ),
    );
    return new Session(chain, dep, sessionId, sessionDir, runtimePath, packsDir, evidenceDir);
  }

  async balances(): Promise<Record<string, string>> {
    const token = this.dep.token as any;
    const out: Record<string, string> = {};
    for (const role of ["buyer", "provider", "thirdParty", "deployer"] as const) {
      out[role] = (await token.balanceOf(this.chain.addresses[role])).toString();
    }
    out.escrow = (await token.balanceOf(this.dep.addresses.escrow)).toString();
    out.totalLocked = (await (this.dep.escrow as any).totalLocked()).toString();
    return out;
  }

  packFor(scenario: Scenario, source: RecordRow[]): AcceptancePack {
    const base = buildPack({
      title: scenario.label,
      source,
      payment: {
        tokenSymbol: "mUSD",
        paymentToken: this.dep.addresses.token,
        tokenDecimals: 6,
        amountBaseUnits: DEMO_AMOUNT.toString(),
        deliveryWindowSeconds: scenario.id === "expiry" ? 60 : 3600,
        settlementWindowSeconds: scenario.id === "expiry" ? 60 : 3600,
      },
      includeSubjectiveClause: scenario.includeSubjectiveClause,
    });
    return base;
  }

  private writePack(pack: AcceptancePack, name: string): string {
    const path = join(this.packsDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(pack, null, 2));
    return path;
  }

  // ------------------------------------------------------------- named actions

  /**
   * What an explicit scope revision would produce, without creating anything.
   *
   * A caller approves a revision by passing back the digest of the exact pack version this
   * returns. That is what makes the approval an approval of *that version* rather than a flag
   * that lets automation delete an inconvenient requirement.
   */
  previewScopeRevision(scenarioId: string) {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const source = loadFixture(scenario.sourceFixture);
    const original = this.packFor(scenario, source);
    const cov = coverage(original);
    if (cov.fullyAutomatic) {
      return { needsRevision: false, original, revised: original, revisedPackDigest: packDigest(original), reason: "", coverage: cov };
    }
    const reason = DEFAULT_REVISION_REASON;
    const revised = reviseScope(original, "C5", reason);
    return { needsRevision: true, original, revised, revisedPackDigest: packDigest(revised), reason, coverage: cov };
  }

  /** Step 1 + 2a: buyer proposes the job with an approved pack. */
  async createJob(scenarioId: string, opts: CreateJobOptions = {}): Promise<SessionJob> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const source = loadFixture(scenario.sourceFixture);
    let pack = this.packFor(scenario, source);

    if (!coverage(pack).fullyAutomatic) {
      // A clause software cannot check blocks the job. The only way past it is an explicit
      // revision that names the exact pack version being approved. Nothing here may revise scope
      // on its own initiative, because that would silently delete a requirement to let automation
      // proceed — which is the opposite of what this product claims to do.
      if (!opts.revision) {
        throw new ScopeRevisionRequired(
          `Unsupported scope: this agreement contains ${coverage(pack).unsupportedClauseCount} clause(s) ` +
          `software cannot check, so the job cannot be created. Nothing was created and no funds moved. ` +
          `Review the clause and, if you accept that payment will not depend on it, approve the revised ` +
          `pack explicitly by its digest.`,
          this.previewScopeRevision(scenarioId),
        );
      }
      const preview = this.previewScopeRevision(scenarioId);
      if (opts.revision.approvedPackDigest.toLowerCase() !== preview.revisedPackDigest.toLowerCase()) {
        throw new Error(
          `The approved pack digest ${opts.revision.approvedPackDigest} does not match the revision this ` +
          `would produce (${preview.revisedPackDigest}). An approval must name the exact pack version it approves.`,
        );
      }
      pack = reviseScope(pack, "C5", opts.revision.reason || preview.reason);
    }
    const startBalances = await this.balances();

    const created = await jobs.createJob({
      escrow: this.dep.escrow,
      buyer: this.chain.wallets.buyer,
      provider: this.chain.addresses.provider,
      token: this.dep.addresses.token,
      amount: DEMO_AMOUNT,
      source,
      pack,
      deliveryWindowSeconds: pack.payment.deliveryWindowSeconds,
      settlementWindowSeconds: pack.payment.settlementWindowSeconds,
    });

    const packPath = this.writePack(pack, `job-${created.jobId}-${scenarioId}`);
    const job: SessionJob = {
      jobId: created.jobId.toString(),
      scenarioId,
      pack,
      packPath,
      packDigest: created.packDigest,
      termsDigest: created.termsDigest,
      source,
      amount: DEMO_AMOUNT.toString(),
      startBalances,
      driver: "ui",
      transactions: [{ step: "createJob", ...created.tx }],
      steps: [
        {
          step: "create",
          who: "buyer",
          detail: `Proposed job ${created.jobId}: ${source.length} rows, ${coverage(pack).summary}`,
          tx: created.tx,
          data: { termsDigest: created.termsDigest, sourceDigest: created.sourceDigest, packDigest: created.packDigest },
        },
      ],
    };
    this.jobsById.set(job.jobId, job);
    return job;
  }

  private get(jobId: string): SessionJob {
    const j = this.jobsById.get(jobId);
    if (!j) throw new Error(`This session has no job ${jobId}`);
    return j;
  }

  /** Step 2b: provider verifies the stored terms itself, then accepts them. */
  async accept(jobId: string): Promise<SessionJob> {
    const job = this.get(jobId);
    const verified = await jobs.verifyTermsIndependently(this.dep.escrow, BigInt(jobId), BigInt(this.chain.chainId));
    if (!verified.ok) throw new Error("Provider's independent recomputation of the terms disagrees with the contract.");
    const tx = await jobs.acceptJob(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), verified.chainDigest);
    job.transactions.push({ step: "acceptJob", ...tx });
    job.steps.push({
      step: "accept", who: "provider",
      detail: "Recomputed the terms digest independently, matched it, and accepted on chain.",
      tx, data: { termsDigest: verified.chainDigest },
    });
    return job;
  }

  /** Step 2c: buyer locks the payment. */
  async fund(jobId: string): Promise<SessionJob> {
    const job = this.get(jobId);
    const toppedUp = await this.ensureBuyerCanFund(BigInt(job.amount));
    if (toppedUp) {
      job.steps.push({
        step: "fund", who: "the demonstration",
        detail: `The buyer's test wallet was refilled with ${DEMO_MINT} base units of valueless mUSD so the demonstration can continue. This is a faucet, not income, and it is not part of this job's accounting.`,
      });
    }
    const res = await jobs.fundJob(
      this.dep.escrow, this.dep.token, this.chain.wallets.buyer, BigInt(jobId), job.termsDigest, BigInt(job.amount),
    );
    job.transactions.push({ step: "approve", ...res.approve }, { step: "fundJob", ...res.fund });
    job.steps.push({
      step: "fund", who: "buyer", detail: `Locked ${job.amount} base units of mUSD in escrow.`, tx: res.fund,
    });
    return job;
  }

  /**
   * The one delivery function. It always transforms **this job's own source** with the supported
   * transform, so an imported batch behaves exactly like a built-in fixture.
   *
   * A deliberate defect is an explicit input, never inferred from a job's name. Previously this
   * looked up a built-in scenario and read its `outputFixture`, which crashed for any job that was
   * not one of the seven examples — including every imported batch, which could be funded and then
   * never delivered.
   */
  private deliveryFor(job: SessionJob, flaw?: FlawKind): { output: RecordRow[]; flaw: FlawKind } {
    const chosen: FlawKind = flaw ?? scenarioById(job.scenarioId)?.flaw ?? "none";
    return { output: transform(job.source, chosen), flaw: chosen };
  }

  private describeDelivery(output: RecordRow[], verdictName: string, flaw: FlawKind): string {
    return `Submitted ${output.length} rows. The provider's own pre-submission check says ${verdictName}.` +
      (flaw === "none" ? "" : ` A deliberate "${flaw}" defect was requested for this demonstration.`);
  }

  /**
   * Keep the buyer able to fund the next job.
   *
   * The buyer starts with 1,000 mUSD and each job locks 25, so the fortieth paid job left the
   * wallet empty and the forty-first failed with an undecodable token revert. mUSD is a valueless
   * mock with an unrestricted faucet — refilling it is not income and changes no job's accounting,
   * because per-job figures come from that job's own escrow movements. The interface says when it
   * has happened rather than letting the number quietly climb.
   */
  private async ensureBuyerCanFund(amount: bigint): Promise<boolean> {
    const token = this.dep.token as any;
    const balance = BigInt(await token.balanceOf(this.chain.addresses.buyer));
    if (balance >= amount) return false;
    await (await token.mint(this.chain.addresses.buyer, DEMO_MINT)).wait();
    this.topUps++;
    return true;
  }

  /** Step 3: provider does the work and submits the canonical bundle. */
  async submit(jobId: string, flaw?: FlawKind): Promise<SessionJob> {
    const job = this.get(jobId);
    const { output, flaw: used } = this.deliveryFor(job, flaw);
    const self = check(job.source, output, job.source.length);
    const tx = await jobs.submitDelivery(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), output);
    job.transactions.push({ step: "submitDelivery", ...tx });
    job.steps.push({
      step: "submit", who: "provider",
      detail: this.describeDelivery(output, self.result.verdictName, used),
      tx, data: { deliveryDigest: canonicalDigest(output), selfCheck: self.result.verdictName, flaw: used },
    });
    return job;
  }

  /**
   * Step 3+5 in one transaction. The provider previews its own output first (the UI shows that
   * preview), then records, evaluates and settles atomically. Nothing new is authorised: the
   * caller supplies rows, never a verdict, and the same immutable policy decides.
   */
  async submitAndSettle(jobId: string, flaw?: FlawKind): Promise<SessionJob> {
    const job = this.get(jobId);
    const { output, flaw: used } = this.deliveryFor(job, flaw);
    const self = check(job.source, output, job.source.length);
    const tx = await jobs.submitAndSettle(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), output);
    const after = await jobs.readJob(this.dep.escrow, BigInt(jobId));
    job.transactions.push({ step: "submitAndSettle", ...tx });
    job.steps.push({
      step: "submit", who: "provider",
      detail: this.describeDelivery(output, self.result.verdictName, used),
      tx, data: { deliveryDigest: canonicalDigest(output), selfCheck: self.result.verdictName, flaw: used },
    });
    job.steps.push({
      step: "settle", who: "the same transaction",
      detail: `Settled atomically with the submission. The contract's policy returned ${after.verdict === 1 ? "PASS" : "FAIL"}; status is now ${after.status}.`,
      tx, data: { verdict: after.verdict, ruleId: after.ruleId, failCode: after.failCode, atomic: true },
    });
    return job;
  }

  /** Step 5: anyone requests settlement. The contract decides. */
  async settle(jobId: string, as: Role = "thirdParty"): Promise<SessionJob> {
    const job = this.get(jobId);
    const tx = await jobs.settle(this.dep.escrow, this.chain.wallets[as], BigInt(jobId));
    const after = await jobs.readJob(this.dep.escrow, BigInt(jobId));
    job.transactions.push({ step: "settle", ...tx });
    job.steps.push({
      step: "settle", who: as === "thirdParty" ? "an unrelated account" : as,
      detail: `Requested settlement. The contract's policy returned ${after.verdict === 1 ? "PASS" : "FAIL"}; status is now ${after.status}.`,
      tx, data: { verdict: after.verdict, ruleId: after.ruleId, failCode: after.failCode },
    });
    return job;
  }

  async refundExpired(jobId: string, as: Role = "thirdParty"): Promise<SessionJob> {
    const job = this.get(jobId);
    const tx = await jobs.refundExpired(this.dep.escrow, this.chain.wallets[as], BigInt(jobId));
    job.transactions.push({ step: "refundExpired", ...tx });
    job.steps.push({
      step: "expire", who: as === "thirdParty" ? "an unrelated account" : as,
      detail: "Settlement expiry passed with no valid settlement, so the escrow returned to the buyer. This is a timeout rule, not a finding about the work.",
      tx,
    });
    return job;
  }

  /** Local-chain time travel. Clearly a simulation device; it has no real-world counterpart. */
  async advanceTime(seconds: number): Promise<number> {
    this.timeSkewSeconds += seconds;
    return this.chain.increaseTime(seconds);
  }

  async readJob(jobId: string) {
    return jobs.readJob(this.dep.escrow, BigInt(jobId));
  }

  async preview(jobId: string) {
    const j = await this.readJob(jobId);
    if (!j.output.length) return null;
    return check(j.source, j.output, j.terms.requiredRowCount, j.terms.ruleMask);
  }

  /**
   * Import a batch the operator supplied and rebind the fixed template to it. The template is
   * reused; the job still binds its own source, its own terms and its own pack digest. This is
   * template reuse, not a general-purpose acceptance editor, and the interface says so.
   */
  async createJobFromRows(rows: RecordRow[], title: string): Promise<SessionJob> {
    const template = this.packFor(scenarioById("pass")!, rows);
    const pack = rebindToSource(template, rows, title);
    const startBalances = await this.balances();
    const created = await jobs.createJob({
      escrow: this.dep.escrow,
      buyer: this.chain.wallets.buyer,
      provider: this.chain.addresses.provider,
      token: this.dep.addresses.token,
      amount: DEMO_AMOUNT,
      source: rows,
      pack,
      deliveryWindowSeconds: pack.payment.deliveryWindowSeconds,
      settlementWindowSeconds: pack.payment.settlementWindowSeconds,
    });
    const job: SessionJob = {
      jobId: created.jobId.toString(),
      scenarioId: "imported",
      pack,
      packPath: this.writePack(pack, `job-${created.jobId}-imported`),
      packDigest: created.packDigest,
      termsDigest: created.termsDigest,
      source: rows,
      amount: DEMO_AMOUNT.toString(),
      startBalances,
      driver: "ui",
      transactions: [{ step: "createJob", ...created.tx }],
      steps: [{
        step: "create", who: "buyer",
        detail: `Imported ${rows.length} rows and reused the catalogue-normalization template for them.`,
        tx: created.tx,
        data: { termsDigest: created.termsDigest, sourceDigest: created.sourceDigest, packDigest: created.packDigest },
      }],
    };
    this.jobsById.set(job.jobId, job);
    return job;
  }

  /**
   * The whole flow, driven from one button: propose, verify and accept, fund, then submit and
   * settle in a single transaction. The provider previews its own output before submitting, which
   * is what makes the combined transaction safe for an honest provider.
   */
  async runAutomatic(
    scenarioId: string,
    onStep?: (line: string) => void,
    opts: CreateJobOptions = {},
  ): Promise<SessionJob> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    // createJob throws ScopeRevisionRequired before anything exists or any money moves.
    const job = await this.createJob(scenarioId, opts);
    onStep?.(`Buyer proposed job ${job.jobId} with an approved checklist.`);
    await this.accept(job.jobId);
    onStep?.("Provider agent re-derived the agreement from the contract and accepted it.");
    await this.fund(job.jobId);
    onStep?.("Buyer locked the payment in escrow.");
    if (scenario.submit) {
      await this.submitAndSettle(job.jobId);
      const after = await this.readJob(job.jobId);
      onStep?.(`Provider submitted; the contract checked and settled in the same transaction. ${after.status}.`);
    } else {
      onStep?.("No delivery in this scenario; advancing local chain time past expiry.");
      await this.advanceTime(job.pack.payment.deliveryWindowSeconds + job.pack.payment.settlementWindowSeconds + 5);
      await this.refundExpired(job.jobId);
      onStep?.("Settlement expiry passed, so the escrow returned to the buyer.");
    }
    return this.get(job.jobId);
  }

  /**
   * The same automatic path, for a job that already exists — an imported batch, for instance.
   * Accept, fund, then deliver and settle in one transaction.
   */
  async runAutomaticForJob(jobId: string, onStep?: (line: string) => void): Promise<SessionJob> {
    const job = this.get(jobId);
    const status = (await this.readJob(jobId)).status;
    if (status !== "CREATED") throw new Error(`Job ${jobId} is ${status}; the automatic path starts from CREATED.`);
    await this.accept(jobId);
    onStep?.("Provider agent re-derived the agreement from the contract and accepted it.");
    await this.fund(jobId);
    onStep?.("Buyer locked the payment in escrow.");
    await this.submitAndSettle(jobId);
    const after = await this.readJob(jobId);
    onStep?.(`Provider delivered; the contract checked and settled in the same transaction. ${after.status}.`);
    return this.get(job.jobId);
  }

  // ---------------------------------------------------- running the agent pair

  /**
   * Runs the buyer and provider as real separate OS processes with separate keys.
   * Both are controlled by this orchestrator, which is stated everywhere their output appears.
   *
   * `onLine` is called as each child writes a line, but the HTTP caller only sees the accumulated
   * log once the whole run returns. There are no progress events over the wire, and nothing in the
   * interface claims otherwise.
   */
  async runAgents(scenarioId: string, onLine?: (line: string) => void): Promise<SessionJob> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const source = loadFixture(scenario.sourceFixture);
    let pack = this.packFor(scenario, source);
    // Left unrevised on purpose: the buyer program must refuse it, and that refusal is the
    // demonstration. Nothing here revises scope on the caller's behalf.
    const packPath = this.writePack(pack, `agents-${scenarioId}-${Date.now()}`);
    const startBalances = await this.balances();
    const steps: StepLog[] = [];
    const transactions: EvidenceTx[] = [];

    const run = async (script: string, argv: string[], keyRole: Role) => {
      const env = {
        ...process.env,
        BUYER_KEY: keyRole === "buyer" ? this.chain.wallets.buyer.privateKey : "",
        PROVIDER_KEY: keyRole === "provider" ? this.chain.wallets.provider.privateKey : "",
      };
      return new Promise<any>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(PROJECT_ROOT, script), ...argv],
          { env, cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.stderr.on("data", (d) => {
          for (const line of d.toString().split("\n")) if (line.trim()) onLine?.(line.trimEnd());
        });
        child.on("error", reject);
        child.on("close", (code) => {
          const lastLine = out.trim().split("\n").filter(Boolean).pop();
          let parsed: any = null;
          try { parsed = lastLine ? JSON.parse(lastLine) : null; } catch { /* not JSON */ }
          if (code !== 0 && !parsed) return reject(new Error(`${script} exited ${code}: ${out.slice(-400)}`));
          resolve({ code, parsed });
        });
      });
    };

    const created = await run("src/agents/buyer.ts", [
      "create", "--runtime", this.runtimePath, "--pack", packPath,
      "--source", scenario.sourceFixture, "--provider", this.chain.addresses.provider,
    ], "buyer");

    if (!created.parsed?.ok) {
      const job: SessionJob = {
        jobId: `blocked-${scenarioId}`, scenarioId, pack, packPath, packDigest: packDigest(pack),
        termsDigest: "0x", source, amount: DEMO_AMOUNT.toString(), startBalances, driver: "agents",
        transactions, steps: [{
          step: "create", who: "buyer",
          detail: `The buyer program refused to create the job: ${created.parsed?.reason ?? "unknown reason"}.`,
          data: created.parsed ?? {},
        }],
      };
      this.jobsById.set(job.jobId, job);
      return job;
    }

    const jobId = String(created.parsed.jobId);
    steps.push({ step: "create", who: "buyer", detail: `Created job ${jobId}.`, tx: created.parsed.tx });
    transactions.push({ step: "createJob", ...created.parsed.tx });

    const accepted = await run(
      "src/agents/provider.ts", ["accept", "--runtime", this.runtimePath, "--job", jobId, "--pack", packPath], "provider",
    );
    steps.push({ step: "accept", who: "provider", detail: "Verified the stored terms independently, then accepted.", tx: accepted.parsed.tx });
    transactions.push({ step: "acceptJob", ...accepted.parsed.tx });

    const funded = await run(
      "src/agents/buyer.ts", ["fund", "--runtime", this.runtimePath, "--job", jobId, "--pack", packPath], "buyer",
    );
    steps.push({ step: "fund", who: "buyer", detail: "Locked the payment in escrow.", tx: funded.parsed.fund });
    transactions.push({ step: "approve", ...funded.parsed.approve }, { step: "fundJob", ...funded.parsed.fund });

    const flawByScenario: Record<string, string> = {
      "pass": "none", "fail-order": "order", "fail-price": "price",
      "fail-rowcount": "drop", "fail-unknown-id": "invent",
    };

    const job: SessionJob = {
      jobId, scenarioId, pack, packPath, packDigest: packDigest(pack),
      termsDigest: created.parsed.termsDigest, source, amount: DEMO_AMOUNT.toString(),
      startBalances, driver: "agents", transactions, steps,
    };
    this.jobsById.set(jobId, job);

    if (scenario.submit) {
      const flaw = flawByScenario[scenarioId] ?? "none";
      const submitArgs = ["submit", "--runtime", this.runtimePath, "--job", jobId, "--flaw", flaw];
      // A provider refuses to submit work that fails its own preview. The demonstration scenarios
      // are the only place that override is used, and it is passed explicitly.
      if (flaw !== "none") submitArgs.push("--demonstrate-nonconforming", "true");
      const submitted = await run("src/agents/provider.ts", submitArgs, "provider");
      steps.push({
        step: "submit", who: "provider",
        detail: `Submitted ${submitted.parsed.rowCount} rows; its own pre-submission check said ${submitted.parsed.selfCheck.verdict}.`,
        tx: submitted.parsed.tx,
      });
      transactions.push({ step: submitted.parsed.mode === "two-step" ? "submitDelivery" : "submitAndSettle", ...submitted.parsed.tx });
      if (submitted.parsed.mode === "two-step") {
        await this.settle(jobId);
      } else {
        const after = await jobs.readJob(this.dep.escrow, BigInt(jobId));
        steps.push({
          step: "settle", who: "the same transaction",
          detail: `Settled atomically with the submission; status is now ${after.status}.`,
          tx: submitted.parsed.tx, data: { atomic: true },
        });
      }
    } else {
      onLine?.(`  [orchestrator] no submission in this scenario; advancing local chain time past expiry`);
      await this.advanceTime(pack.payment.deliveryWindowSeconds + pack.payment.settlementWindowSeconds + 5);
      await this.refundExpired(jobId);
    }
    return this.get(jobId);
  }

  // ------------------------------------------------------------------ evidence

  /**
   * What actually moved for one job, read back from that job's own transaction receipts.
   *
   * Only transfers of the approved payment token that involve this escrow are counted, only from
   * transactions this job recorded, and each transaction hash is read once. Nothing here consults
   * a wallet balance, so another job completing — before, after, or concurrently — cannot change
   * the answer.
   */
  async observedTransfersFor(jobId: string): Promise<ObservedTransfers> {
    const job = this.get(jobId);
    const escrow = this.dep.addresses.escrow.toLowerCase();
    const token = this.dep.addresses.token.toLowerCase();
    const iface = (this.dep.token as any).interface;

    const seen = new Set<string>();
    const transfers: ObservedTransfer[] = [];
    for (const t of job.transactions) {
      if (seen.has(t.hash.toLowerCase())) continue;
      seen.add(t.hash.toLowerCase());
      const receipt = await this.chain.provider.getTransactionReceipt(t.hash);
      if (!receipt) continue;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== token) continue;
        let parsed;
        try { parsed = iface.parseLog(log); } catch { continue; }
        if (!parsed || parsed.name !== "Transfer") continue;
        const from = String(parsed.args.from).toLowerCase();
        const to = String(parsed.args.to).toLowerCase();
        if (from !== escrow && to !== escrow) continue;
        transfers.push({
          txHash: t.hash,
          step: t.step,
          logIndex: log.index,
          from: String(parsed.args.from),
          to: String(parsed.args.to),
          value: parsed.args.value.toString(),
          direction: to === escrow ? "in" : "out",
        });
      }
    }

    // The summary is derived, never assembled separately: exporter and verifier share one
    // calculation so their two accounts of the same movements cannot drift apart.
    const derived = deriveMovements(transfers, this.dep.addresses.escrow, {
      ...this.chain.addresses, escrow: this.dep.addresses.escrow,
    });
    if (derived.issues.length) {
      throw new Error(`Refusing to export evidence: this job's movements are inconsistent.\n${derived.issues.join("\n")}`);
    }

    return {
      paymentToken: this.dep.addresses.token,
      escrow: this.dep.addresses.escrow,
      transfers,
      fundedIn: derived.fundedIn,
      paidOut: derived.paidOut,
      paidTo: derived.paidTo,
    };
  }

  /** Net movement per role, attributable to this job alone. Same calculation as the summary. */
  static deltasFrom(observed: ObservedTransfers, roles: Record<string, string>): Record<string, string> {
    return deriveMovements(observed.transfers, observed.escrow, roles).net;
  }

  async exportEvidence(jobId: string): Promise<EvidenceBundle> {
    const job = this.get(jobId);
    const onChain = await this.readJob(jobId);
    const observedTransfers = await this.observedTransfersFor(jobId);
    const roles = { ...this.chain.addresses, escrow: this.dep.addresses.escrow };
    const deltas = Session.deltasFrom(observedTransfers, roles);
    const currentWalletBalances = await this.balances();

    return {
      bundleFormat: "acceptance-evidence/v1",
      exportedAt: new Date().toISOString(),
      build: {
        solcVersion: this.chain.artifacts.solcVersion,
        sourcesHash: this.chain.artifacts.sourcesHash,
        encodingVersion: 1,
        codeRevision: process.env.ACCEPTANCE_REVISION ?? "not a git repository",
      },
      chain: {
        chainId: this.chain.chainId,
        label: "disposable local Ganache chain (not a public network)",
        escrow: this.dep.addresses.escrow,
        policy: this.dep.addresses.policy,
        paymentToken: this.dep.addresses.token,
      },
      job: {
        jobId: onChain.jobId,
        status: onChain.status,
        buyer: onChain.terms.buyer,
        provider: onChain.terms.provider,
        amountBaseUnits: onChain.terms.amount,
        tokenSymbol: "mUSD",
        tokenDecimals: 6,
        createdAt: onChain.createdAt,
        deliveryDeadline: onChain.terms.deliveryDeadline,
        settlementExpiry: onChain.terms.settlementExpiry,
        submittedAt: onChain.submittedAt,
        settledAt: onChain.settledAt,
      },
      pack: job.pack,
      commitments: {
        packDigest: onChain.terms.packDigest,
        sourceDigest: onChain.terms.sourceDigest,
        deliveryDigest: onChain.deliveryDigest,
        termsDigest: onChain.termsDigest,
      },
      terms: {
        chainId: String(this.chain.chainId),
        escrow: this.dep.addresses.escrow,
        jobId: onChain.jobId,
        buyer: onChain.terms.buyer,
        provider: onChain.terms.provider,
        paymentToken: onChain.terms.paymentToken,
        amount: onChain.terms.amount,
        sourceDigest: onChain.terms.sourceDigest,
        requiredRowCount: onChain.terms.requiredRowCount,
        policyId: onChain.terms.policyId,
        policyVersion: onChain.terms.policyVersion,
        ruleMask: onChain.terms.ruleMask,
        packDigest: onChain.terms.packDigest,
        deliveryDeadline: String(onChain.terms.deliveryDeadline),
        settlementExpiry: String(onChain.terms.settlementExpiry),
      },
      source: rowsOut(onChain.source),
      delivery: onChain.output.length ? rowsOut(onChain.output) : null,
      recordedVerdict: {
        verdict: onChain.verdict,
        verdictName: ["INDETERMINATE", "PASS", "FAIL"][onChain.verdict] ?? "INDETERMINATE",
        ruleId: onChain.ruleId,
        failCode: onChain.failCode,
        detailA: onChain.detailA,
        detailB: onChain.detailB,
      },
      transactions: job.transactions,
      balanceDeltas: deltas,
      observedTransfers,
      currentWalletBalances,
      caveats: BUNDLE_CAVEATS,
    };
  }

  async close() {
    await this.chain.close();
  }
}

export { SCENARIOS, JobStatus };
