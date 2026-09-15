/**
 * The job lifecycle, in the browser.
 *
 * This mirrors src/chain/session.ts. It exists because GitHub Pages serves static files and cannot
 * run a Node process — not because the demonstration is any less real. Every rule is enforced by
 * the same compiled contracts, and the figures come from the same shared modules the test suite
 * checks: encoding, policy, pack, agreement, transfers, evidence.
 *
 * What the static build does NOT offer, and says so in the interface: the buyer and supplier as
 * separate operating-system processes. A tab cannot spawn processes, and showing the same code
 * in-page under that label would claim something untrue.
 */
import { parseUnits } from "ethers";
import * as jobs from "../chain/jobs.ts";
import { canonicalDigest } from "../shared/encoding.ts";
import { buildPack, coverage, packDigest, rebindToSource, reviseScope, type AcceptancePack } from "../shared/pack.ts";
import { check } from "../shared/policy.ts";
import { SCENARIOS, scenarioById, type FlawKind, type Scenario } from "../shared/scenarios.ts";
import { RULES, type RecordRow } from "../shared/types.ts";
import { transform } from "../shared/transform.ts";
import { deriveMovements } from "../shared/transfers.ts";
import {
  BUNDLE_CAVEATS, rowsOut, verifyBundle,
  type EvidenceBundle, type EvidenceTx, type ObservedTransfer, type ObservedTransfers,
} from "../shared/evidence.ts";
import { loadFixture } from "./fixtures.ts";
import { startBrowserChain, deployAll, type BrowserChain, type Deployment, type Role } from "./browserChain.ts";
import { API_VERSION } from "../shared/apiVersion.ts";

export const DEMO_AMOUNT = parseUnits("25", 6);
export const DEMO_MINT = parseUnits("1000", 6);
export const DEFAULT_REVISION_REASON =
  "Descriptions will be reviewed by a person, outside this agreement.";

export interface StepLog { step: string; who: string; detail: string; tx?: jobs.TxInfo; data?: Record<string, unknown> }

export interface EngineJob {
  jobId: string;
  scenarioId: string;
  pack: AcceptancePack;
  packDigest: string;
  termsDigest: string;
  source: RecordRow[];
  amount: string;
  steps: StepLog[];
  transactions: EvidenceTx[];
}

export class ScopeRevisionRequired extends Error {
  constructor(message: string, readonly preview: ReturnType<Engine["previewScopeRevision"]>) {
    super(message);
    this.name = "ScopeRevisionRequired";
  }
}

export class Engine {
  readonly jobsById = new Map<string, EngineJob>();
  timeSkewSeconds = 0;
  topUps = 0;

  private constructor(readonly chain: BrowserChain, readonly dep: Deployment) {}

  static async start(): Promise<Engine> {
    const chain = await startBrowserChain();
    const dep = await deployAll(chain);
    const token = dep.token as any;
    for (const role of ["buyer", "provider", "thirdParty"] as const) {
      await (await token.mint(chain.addresses[role], DEMO_MINT)).wait();
    }
    return new Engine(chain, dep);
  }

  // --------------------------------------------------------------- read

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

  async readJob(jobId: string) { return jobs.readJob(this.dep.escrow, BigInt(jobId)); }

  private get(jobId: string): EngineJob {
    const j = this.jobsById.get(jobId);
    if (!j) throw new Error(`This session has no job ${jobId}`);
    return j;
  }

  async state() {
    return {
      apiVersion: API_VERSION,
      chain: {
        chainId: this.chain.chainId,
        label: "disposable chain running in this browser tab",
        addresses: this.dep.addresses,
        roles: this.chain.addresses,
        solcVersion: this.chain.artifacts.solcVersion,
        contractSourcesHash: this.chain.artifacts.sourcesHash,
        now: await this.chain.now(),
        timeSkewSeconds: this.timeSkewSeconds,
      },
      token: { symbol: "mUSD", decimals: 6 },
      rules: RULES,
      scenarios: SCENARIOS,
      blockedActions: [],
      balances: await this.balances(),
      topUps: this.topUps,
      jobs: await Promise.all([...this.jobsById.keys()].map(async (id) => ({
        jobId: id,
        scenarioId: this.jobsById.get(id)!.scenarioId,
        status: (await this.readJob(id)).status,
        driver: "ui",
      }))),
    };
  }

  async jobDetail(jobId: string) {
    const job = this.get(jobId);
    const onChain = await this.readJob(jobId);
    const observed = await this.observedTransfersFor(jobId);
    return {
      ...job,
      onChain,
      observedTransfers: observed,
      balanceDeltas: deriveMovements(observed.transfers, observed.escrow, {
        ...this.chain.addresses, escrow: this.dep.addresses.escrow,
      }).net,
      coverage: coverage(job.pack),
      packDigestRecomputed: packDigest(job.pack),
      localPreview: onChain.output.length
        ? check(onChain.source, onChain.output, onChain.terms.requiredRowCount, onChain.terms.ruleMask)
        : null,
      now: await this.chain.now(),
    };
  }

  // ------------------------------------------------------------ packs

  packFor(scenario: Scenario, source: readonly RecordRow[]): AcceptancePack {
    return buildPack({
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
  }

  previewScopeRevision(scenarioId: string) {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const original = this.packFor(scenario, loadFixture(scenario.sourceFixture));
    const cov = coverage(original);
    if (cov.fullyAutomatic) {
      return { needsRevision: false, original, revised: original, revisedPackDigest: packDigest(original), reason: "", coverage: cov };
    }
    const revised = reviseScope(original, "C5", DEFAULT_REVISION_REASON);
    return { needsRevision: true, original, revised, revisedPackDigest: packDigest(revised), reason: DEFAULT_REVISION_REASON, coverage: cov };
  }

  // ----------------------------------------------------------- actions

  private record(pack: AcceptancePack, scenarioId: string, created: jobs.CreatedJob, source: RecordRow[], detail: string): EngineJob {
    const job: EngineJob = {
      jobId: created.jobId.toString(),
      scenarioId,
      pack,
      packDigest: created.packDigest,
      termsDigest: created.termsDigest,
      source,
      amount: DEMO_AMOUNT.toString(),
      transactions: [{ step: "createJob", ...created.tx }],
      steps: [{ step: "create", who: "buyer", detail, tx: created.tx,
        data: { termsDigest: created.termsDigest, sourceDigest: created.sourceDigest, packDigest: created.packDigest } }],
    };
    this.jobsById.set(job.jobId, job);
    return job;
  }

  async createJob(scenarioId: string, opts: { revision?: { approvedPackDigest: string; reason: string } } = {}): Promise<EngineJob> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const source = loadFixture(scenario.sourceFixture);
    let pack = this.packFor(scenario, source);

    if (!coverage(pack).fullyAutomatic) {
      const preview = this.previewScopeRevision(scenarioId);
      if (!opts.revision) {
        throw new ScopeRevisionRequired(
          `Unsupported scope: this agreement contains ${coverage(pack).unsupportedClauseCount} clause(s) ` +
          `software cannot check, so the job cannot be created. Nothing was created and no funds moved. ` +
          `Review the clause and, if you accept that payment will not depend on it, approve the revised ` +
          `pack explicitly by its digest.`,
          preview,
        );
      }
      if (opts.revision.approvedPackDigest.toLowerCase() !== preview.revisedPackDigest.toLowerCase()) {
        throw new Error(
          `The approved pack digest ${opts.revision.approvedPackDigest} does not match the revision this ` +
          `would produce (${preview.revisedPackDigest}). An approval must name the exact pack version it approves.`,
        );
      }
      pack = reviseScope(pack, "C5", opts.revision.reason || preview.reason);
    }

    const created = await jobs.createJob({
      escrow: this.dep.escrow,
      buyer: this.chain.wallets.buyer,
      provider: this.chain.addresses.provider,
      token: this.dep.addresses.token,
      amount: DEMO_AMOUNT,
      source, pack,
      deliveryWindowSeconds: pack.payment.deliveryWindowSeconds,
      settlementWindowSeconds: pack.payment.settlementWindowSeconds,
    });
    return this.record(pack, scenarioId, created, source,
      `Proposed job ${created.jobId}: ${source.length} rows, ${coverage(pack).summary}`);
  }

  async createJobFromRows(rows: RecordRow[], title: string): Promise<EngineJob> {
    const pack = rebindToSource(this.packFor(scenarioById("pass")!, rows), rows, title);
    const created = await jobs.createJob({
      escrow: this.dep.escrow,
      buyer: this.chain.wallets.buyer,
      provider: this.chain.addresses.provider,
      token: this.dep.addresses.token,
      amount: DEMO_AMOUNT,
      source: rows, pack,
      deliveryWindowSeconds: pack.payment.deliveryWindowSeconds,
      settlementWindowSeconds: pack.payment.settlementWindowSeconds,
    });
    return this.record(pack, "imported", created, rows,
      `Imported ${rows.length} rows and reused the catalogue-normalization template for them.`);
  }

  async accept(jobId: string): Promise<EngineJob> {
    const job = this.get(jobId);
    const verified = await jobs.verifyTermsIndependently(this.dep.escrow, BigInt(jobId), BigInt(this.chain.chainId));
    if (!verified.ok) throw new Error("The supplier's independent recomputation of the terms disagrees with the contract.");
    const tx = await jobs.acceptJob(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), verified.chainDigest);
    job.transactions.push({ step: "acceptJob", ...tx });
    job.steps.push({ step: "accept", who: "supplier", tx,
      detail: "Re-derived the agreement from what the contract stored, matched it, and accepted on chain." });
    return job;
  }

  /** mUSD is a valueless mock with an open faucet; refilling is not income. */
  private async ensureBuyerCanFund(amount: bigint): Promise<boolean> {
    const token = this.dep.token as any;
    if (BigInt(await token.balanceOf(this.chain.addresses.buyer)) >= amount) return false;
    await (await token.mint(this.chain.addresses.buyer, DEMO_MINT)).wait();
    this.topUps++;
    return true;
  }

  async fund(jobId: string): Promise<EngineJob> {
    const job = this.get(jobId);
    if (await this.ensureBuyerCanFund(BigInt(job.amount))) {
      job.steps.push({ step: "fund", who: "the demonstration",
        detail: `The buyer's test wallet was refilled with ${DEMO_MINT} base units of valueless mUSD so the demonstration can continue. This is a faucet, not income, and it is not part of this job's accounting.` });
    }
    const res = await jobs.fundJob(this.dep.escrow, this.dep.token, this.chain.wallets.buyer, BigInt(jobId), job.termsDigest, BigInt(job.amount));
    job.transactions.push({ step: "approve", ...res.approve }, { step: "fundJob", ...res.fund });
    job.steps.push({ step: "fund", who: "buyer", tx: res.fund, detail: `Locked ${job.amount} base units of mUSD in escrow.` });
    return job;
  }

  private delivery(job: EngineJob, flaw?: FlawKind) {
    const chosen: FlawKind = flaw ?? scenarioById(job.scenarioId)?.flaw ?? "none";
    return { output: transform(job.source, chosen), flaw: chosen };
  }

  private describe(output: RecordRow[], verdict: string, flaw: FlawKind) {
    return `Submitted ${output.length} rows. The supplier's own pre-submission check says ${verdict}.` +
      (flaw === "none" ? "" : ` A deliberate "${flaw}" defect was requested for this demonstration.`);
  }

  async submit(jobId: string, flaw?: FlawKind): Promise<EngineJob> {
    const job = this.get(jobId);
    const { output, flaw: used } = this.delivery(job, flaw);
    const self = check(job.source, output, job.source.length);
    const tx = await jobs.submitDelivery(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), output);
    job.transactions.push({ step: "submitDelivery", ...tx });
    job.steps.push({ step: "submit", who: "supplier", tx, detail: this.describe(output, self.result.verdictName, used),
      data: { deliveryDigest: canonicalDigest(output), selfCheck: self.result.verdictName, flaw: used } });
    return job;
  }

  async submitAndSettle(jobId: string, flaw?: FlawKind): Promise<EngineJob> {
    const job = this.get(jobId);
    const { output, flaw: used } = this.delivery(job, flaw);
    const self = check(job.source, output, job.source.length);
    const tx = await jobs.submitAndSettle(this.dep.escrow, this.chain.wallets.provider, BigInt(jobId), output);
    const after = await this.readJob(jobId);
    job.transactions.push({ step: "submitAndSettle", ...tx });
    job.steps.push({ step: "submit", who: "supplier", tx, detail: this.describe(output, self.result.verdictName, used),
      data: { deliveryDigest: canonicalDigest(output), selfCheck: self.result.verdictName, flaw: used } });
    job.steps.push({ step: "settle", who: "the same transaction", tx,
      detail: `Settled atomically with the submission. The contract's policy returned ${after.verdict === 1 ? "PASS" : "FAIL"}; status is now ${after.status}.`,
      data: { verdict: after.verdict, ruleId: after.ruleId, failCode: after.failCode, atomic: true } });
    return job;
  }

  async settle(jobId: string, as: Role = "thirdParty"): Promise<EngineJob> {
    const job = this.get(jobId);
    const tx = await jobs.settle(this.dep.escrow, this.chain.wallets[as], BigInt(jobId));
    const after = await this.readJob(jobId);
    job.transactions.push({ step: "settle", ...tx });
    job.steps.push({ step: "settle", who: as === "thirdParty" ? "an unrelated account" : as, tx,
      detail: `Requested settlement. The contract's policy returned ${after.verdict === 1 ? "PASS" : "FAIL"}; status is now ${after.status}.`,
      data: { verdict: after.verdict, ruleId: after.ruleId, failCode: after.failCode } });
    return job;
  }

  async refundExpired(jobId: string, as: Role = "thirdParty"): Promise<EngineJob> {
    const job = this.get(jobId);
    const tx = await jobs.refundExpired(this.dep.escrow, this.chain.wallets[as], BigInt(jobId));
    job.transactions.push({ step: "refundExpired", ...tx });
    job.steps.push({ step: "expire", who: as === "thirdParty" ? "an unrelated account" : as, tx,
      detail: "Settlement expiry passed with no valid settlement, so the escrow returned to the buyer. This is a timeout rule, not a finding about the work." });
    return job;
  }

  async advanceTime(seconds: number): Promise<number> {
    this.timeSkewSeconds += seconds;
    return this.chain.increaseTime(seconds);
  }

  async runAutomatic(scenarioId: string, onStep?: (l: string) => void, opts: { revision?: { approvedPackDigest: string; reason: string } } = {}): Promise<EngineJob> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const job = await this.createJob(scenarioId, opts);
    onStep?.(`Buyer proposed job ${job.jobId} with an approved checklist.`);
    await this.accept(job.jobId);
    onStep?.("Supplier re-derived the agreement from the contract and accepted it.");
    await this.fund(job.jobId);
    onStep?.("Buyer locked the payment in escrow.");
    if (scenario.submit) {
      await this.submitAndSettle(job.jobId);
      onStep?.(`Supplier submitted; the contract checked and settled in the same transaction. ${(await this.readJob(job.jobId)).status}.`);
    } else {
      onStep?.("No delivery in this scenario; advancing local chain time past expiry.");
      await this.advanceTime(job.pack.payment.deliveryWindowSeconds + job.pack.payment.settlementWindowSeconds + 5);
      await this.refundExpired(job.jobId);
      onStep?.("Settlement expiry passed, so the escrow returned to the buyer.");
    }
    return this.get(job.jobId);
  }

  async runAutomaticForJob(jobId: string, onStep?: (l: string) => void): Promise<EngineJob> {
    const status = (await this.readJob(jobId)).status;
    if (status !== "CREATED") throw new Error(`Job ${jobId} is ${status}; the automatic path starts from CREATED.`);
    await this.accept(jobId);
    onStep?.("Supplier re-derived the agreement from the contract and accepted it.");
    await this.fund(jobId);
    onStep?.("Buyer locked the payment in escrow.");
    await this.submitAndSettle(jobId);
    onStep?.(`Supplier delivered; the contract checked and settled in the same transaction. ${(await this.readJob(jobId)).status}.`);
    return this.get(jobId);
  }

  // ---------------------------------------------------------- evidence

  /** Derived from this job's own receipts. Never a subtraction of wallet balances. */
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
          txHash: t.hash, step: t.step, logIndex: log.index,
          from: String(parsed.args.from), to: String(parsed.args.to),
          value: parsed.args.value.toString(),
          direction: to === escrow ? "in" : "out",
        });
      }
    }

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

  async exportEvidence(jobId: string): Promise<EvidenceBundle> {
    const job = this.get(jobId);
    const onChain = await this.readJob(jobId);
    const observedTransfers = await this.observedTransfersFor(jobId);
    const roles = { ...this.chain.addresses, escrow: this.dep.addresses.escrow };
    const deltas = deriveMovements(observedTransfers.transfers, observedTransfers.escrow, roles).net;

    return {
      bundleFormat: "acceptance-evidence/v1",
      exportedAt: new Date().toISOString(),
      build: {
        solcVersion: this.chain.artifacts.solcVersion,
        sourcesHash: this.chain.artifacts.sourcesHash,
        encodingVersion: 1,
        codeRevision: "static build",
      },
      chain: {
        chainId: this.chain.chainId,
        label: "disposable chain running in a browser tab (not a public network)",
        escrow: this.dep.addresses.escrow,
        policy: this.dep.addresses.policy,
        paymentToken: this.dep.addresses.token,
      },
      job: {
        jobId: onChain.jobId, status: onChain.status,
        buyer: onChain.terms.buyer, provider: onChain.terms.provider,
        amountBaseUnits: onChain.terms.amount, tokenSymbol: "mUSD", tokenDecimals: 6,
        createdAt: onChain.createdAt,
        deliveryDeadline: onChain.terms.deliveryDeadline,
        settlementExpiry: onChain.terms.settlementExpiry,
        submittedAt: onChain.submittedAt, settledAt: onChain.settledAt,
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
        ruleId: onChain.ruleId, failCode: onChain.failCode,
        detailA: onChain.detailA, detailB: onChain.detailB,
      },
      transactions: job.transactions,
      balanceDeltas: deltas,
      observedTransfers,
      currentWalletBalances: await this.balances(),
      caveats: BUNDLE_CAVEATS,
    };
  }

  async evidence(jobId: string) {
    const bundle = await this.exportEvidence(jobId);
    return { bundle, verification: verifyBundle(bundle) };
  }
}
