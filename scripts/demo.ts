#!/usr/bin/env node
/**
 * Runs the whole local demonstration headlessly and writes evidence.
 *
 * Usage: npm run demo            all scenarios and all blocked actions
 *        npm run demo -- pass    one scenario
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Session, DEMO_EVIDENCE_DIR } from "../src/chain/session.ts";
import { runBlockedAction, type BlockedResult } from "../src/chain/blocked.ts";
import { SCENARIOS, BLOCKED_ACTIONS } from "../src/shared/scenarios.ts";
import { verifyBundle, bundleJson } from "../src/shared/evidence.ts";
import { formatTokenAmount } from "../src/shared/encoding.ts";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

console.log(bold("\nAcceptance MVP — local demonstration"));
console.log(dim("Local simulation. Synthetic data. Test tokens with no value. Every participant is"));
console.log(dim("controlled by one operator: the buyer and supplier programs are deterministic software,"));
console.log(dim("not language models, and they are started by this script.\n"));

const session = await Session.start({ evidenceDir: DEMO_EVIDENCE_DIR, clearEvidenceDir: true });
mkdirSync(DEMO_EVIDENCE_DIR, { recursive: true });

const results: any[] = [];
const blockedResults: BlockedResult[] = [];
let failures = 0;

try {
  console.log(dim(`chain id ${session.chain.chainId}   escrow ${session.dep.addresses.escrow}`));
  console.log(dim(`policy ${session.dep.addresses.policy}   token ${session.dep.addresses.token}\n`));

  for (const scenario of scenarios) {
    console.log(bold(`── ${scenario.label}`));
    console.log(dim(`   ${scenario.short}`));
    const job = await session.runAgents(scenario.id, (line) => console.log(dim(line)));
    const onChain = job.jobId.startsWith("blocked-") ? null : await session.readJob(job.jobId);
    const status = onChain?.status ?? "BLOCKED_AT_CREATION";
    const expected = scenario.expectedTerminalStatus;
    const ok = status === expected && (!onChain || onChain.ruleId === scenario.expectedRuleId);

    if (ok) console.log(green(`   ✓ ${status}`) + (onChain?.ruleId ? dim(`  (rule ${onChain.ruleId})`) : ""));
    else { failures++; console.log(red(`   ✗ ${status}, expected ${expected}`)); }

    let verification = null;
    if (onChain) {
      const bundle = await session.exportEvidence(job.jobId);
      const path = join(session.evidenceDir, `job-${job.jobId}-${scenario.id}.json`);
      writeFileSync(path, bundleJson(bundle));
      verification = verifyBundle(bundle);
      if (!verification.ok) { failures++; console.log(red("   ✗ exported evidence did not verify")); }
      const paidTo = onChain.status === "PAID" ? "supplier" : onChain.status === "NONE" ? "-" : "buyer";
      console.log(dim(`   payment ${formatTokenAmount(BigInt(onChain.terms.amount), 6)} mUSD -> ${paidTo}`));
      console.log(dim(`   evidence -> ${path.replace(process.cwd() + "/", "")}  (offline verify: ${verification.ok ? "ok" : "FAILED"})`));
    }
    results.push({
      scenario: scenario.id, expected, actual: status, ok,
      ruleId: onChain?.ruleId ?? null, failCode: onChain?.failCode ?? null,
      jobId: job.jobId, transactions: job.transactions.length,
      evidenceVerified: verification?.ok ?? null,
    });
    console.log();
  }

  if (!only.length) {
    console.log(bold("── Unauthorized actions, actually attempted"));
    for (const action of BLOCKED_ACTIONS) {
      const r = await runBlockedAction(session, action.id);
      blockedResults.push(r);
      const good = r.outcome === "REJECTED" && r.balancesUnchanged;
      if (!good) failures++;
      console.log(
        `   ${good ? green("✓") : red("✗")} ${r.label}\n` +
        dim(`     rejected with ${r.error.name}${r.error.args.length ? `(${r.error.args.join(", ")})` : ""}; ` +
            `status stayed ${r.statusAfter}; balances unchanged: ${r.balancesUnchanged}`),
      );
    }
    console.log();
  }

  const summary = {
    ranAt: new Date().toISOString(),
    chainId: session.chain.chainId,
    addresses: session.dep.addresses,
    solcVersion: session.chain.artifacts.solcVersion,
    contractSourcesHash: session.chain.artifacts.sourcesHash,
    scenarios: results,
    blockedActions: blockedResults,
    finalBalances: await session.balances(),
    failures,
    caveat: "Local simulation with synthetic data and valueless test tokens. Demonstrates mechanism, not demand.",
  };
  writeFileSync(join(session.evidenceDir, "demo-results.json"), JSON.stringify(summary, null, 2));

  const locked = BigInt(summary.finalBalances.totalLocked ?? "0");
  console.log(bold("── Reconciliation"));
  console.log(`   escrow still holds ${summary.finalBalances.escrow} base units; contract says ${locked} are owed`);
  if (locked !== 0n || BigInt(summary.finalBalances.escrow ?? "0") !== 0n) {
    console.log(yellow("   note: a job is still open, so the escrow legitimately holds funds"));
  }
  console.log(dim(`\n   summary -> ${join(session.evidenceDir, "demo-results.json").replace(process.cwd() + "/", "")}`));
  console.log(failures === 0 ? green(bold(`\n   ${results.length} scenarios, ${blockedResults.length} blocked actions, 0 failures\n`))
                             : red(bold(`\n   ${failures} failure(s)\n`)));
} finally {
  await session.close();
}

process.exit(failures === 0 ? 0 : 1);
