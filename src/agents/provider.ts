#!/usr/bin/env node
/**
 * Supplier program. A separate process with its own local identity.
 *
 * Commands:
 *   accept --runtime <path> --job <id> --pack <file>
 *   submit --runtime <path> --job <id> [--flaw none|order|price|drop|invent]
 *          [--two-step] [--demonstrate-nonconforming]
 *
 * Before accepting it runs the full agreement validator against the terms the contract actually
 * stored. Matching fingerprints are not enough: a pack can be perfectly well formed, hash exactly
 * as advertised, and still describe a different sum of money, a different source batch, or a
 * promise no check covers. All of those are refused here.
 *
 * Before submitting it runs the agreed checks on its own work. A delivery that fails them is
 * refused unless `--demonstrate-nonconforming` is passed, which exists so the demo can show a
 * genuine FAIL and is never used by accident.
 */
import { readFileSync } from "node:fs";
import { connectAgent, emit, parseArgs, say, transform, type FlawKind } from "./common.ts";
import * as jobs from "../chain/jobs.ts";
import { canonicalDigest } from "../shared/encoding.ts";
import { type AcceptancePack } from "../shared/pack.ts";
import { validateAgreement } from "../shared/agreement.ts";
import { check } from "../shared/policy.ts";

const args = parseArgs(process.argv.slice(2));
const command = process.argv[2];
const ctx = connectAgent("PROVIDER_KEY", args.runtime);
const me = "supplier";
const jobId = BigInt(args.job!);

function refuse(action: string, reason: string, summary: string): never {
  say(me, `refusing to ${action}:`);
  for (const line of summary.split("\n")) say(me, `  ${line}`);
  emit({ agent: me, action, ok: false, reason, issues: summary });
  process.exit(2);
}

if (command === "accept") {
  if (!args.pack) {
    refuse("accept", "PACK_MISSING",
      "No --pack was supplied. Accepting a job without reading the agreement it is bound to would " +
      "mean agreeing to terms I have not seen.");
  }
  const pack = JSON.parse(readFileSync(args.pack!, "utf8")) as AcceptancePack;
  const onChain = await jobs.readJob(ctx.escrow, jobId);
  const verified = await jobs.verifyTermsIndependently(ctx.escrow, jobId, BigInt(ctx.runtime.chainId));
  const approvedToken: string = await (ctx.escrow as any).paymentToken();
  const approvedDecimals = Number(await (ctx.token as any).decimals());

  const agreement = validateAgreement({
    pack,
    terms: verified.terms,
    storedTermsDigest: verified.chainDigest,
    createdAt: onChain.createdAt,
    sourceRows: onChain.source,
    expect: {
      role: "provider", address: ctx.wallet.address, approvedPaymentToken: approvedToken,
      approvedTokenDecimals: approvedDecimals,
      chainId: BigInt(ctx.runtime.chainId), escrow: ctx.runtime.addresses.escrow,
    },
  });
  if (!agreement.ok) refuse("accept", agreement.issues[0]!.code, agreement.summary);

  say(me, `pack "${pack.title}" v${pack.packVersion} validated against the stored terms`);
  say(me, `agreed: ${verified.terms.requiredRowCount} rows, ${verified.terms.amount} base units of ${approvedToken}, policy v${verified.terms.policyVersion}`);
  const tx = await jobs.acceptJob(ctx.escrow, ctx.wallet, jobId, verified.chainDigest);
  say(me, `accepted in ${tx.hash.slice(0, 18)}…`);
  emit({ agent: me, action: "accept", ok: true, jobId, tx, termsDigest: verified.chainDigest });
} else if (command === "submit") {
  const flaw = (args.flaw ?? "none") as FlawKind;
  const job = await jobs.readJob(ctx.escrow, jobId);
  const output = transform(job.source, flaw);

  // Preview before submitting. This is the same code the contract runs, it costs nothing, and it
  // is what makes a one-transaction submit-and-settle safe for an honest supplier.
  const selfCheck = check(job.source, output, job.terms.requiredRowCount);
  say(me, `self-check before submitting: ${selfCheck.result.verdictName}`);
  say(me, selfCheck.headline);

  const deliberate = args["demonstrate-nonconforming"] === "true";
  if (selfCheck.result.verdictName !== "PASS" && !deliberate) {
    refuse("submit", "SELF_CHECK_FAILED",
      `My own delivery does not satisfy the agreed rules. Submitting it would forfeit the job.\n` +
      `${selfCheck.headline}\n` +
      `Pass --demonstrate-nonconforming to submit anyway; that flag exists only for the demonstration.`);
  }
  if (deliberate) say(me, `(deliberate defect "${flaw}" submitted on purpose, for the demonstration)`);

  // One transaction by default: record, evaluate and settle atomically. --two-step keeps the
  // original separate-settlement path available for comparison and for the expiry scenarios.
  const twoStep = args["two-step"] === "true";
  const tx = twoStep
    ? await jobs.submitDelivery(ctx.escrow, ctx.wallet, jobId, output)
    : await jobs.submitAndSettle(ctx.escrow, ctx.wallet, jobId, output);
  const after = await jobs.readJob(ctx.escrow, jobId);
  say(me, `submitted ${output.length} rows, digest ${canonicalDigest(output).slice(0, 18)}… (${twoStep ? "two-step" : "submit-and-settle"})`);
  say(me, `job is now ${after.status}`);

  emit({
    agent: me, action: "submit", ok: true, jobId, flaw, tx, mode: twoStep ? "two-step" : "submit-and-settle",
    rowCount: output.length, deliveryDigest: canonicalDigest(output), status: after.status,
    selfCheck: { verdict: selfCheck.result.verdictName, ruleId: selfCheck.result.ruleId, headline: selfCheck.headline },
  });
} else {
  throw new Error(`Unknown supplier command: ${command}. Use "accept" or "submit".`);
}
