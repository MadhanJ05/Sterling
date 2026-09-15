#!/usr/bin/env node
/**
 * Buyer program. A separate process with its own local identity.
 *
 * Commands:
 *   create --runtime <path> --pack <file> --source <fixture> --provider <address> [--amount n]
 *   fund   --runtime <path> --job <id> --pack <file>
 *
 * It performs only these two named actions. It cannot approve work, choose a verdict, or move
 * escrowed funds. Before each one it runs the full agreement validator: an agreement that does not
 * describe the job the contract actually holds is refused, not merely noted.
 */
import { readFileSync } from "node:fs";
import { connectAgent, emit, parseArgs, say } from "./common.ts";
import { loadFixture } from "../chain/fixtures.ts";
import * as jobs from "../chain/jobs.ts";
import { type AcceptancePack } from "../shared/pack.ts";
import { validateAgreement, validatePackStructure } from "../shared/agreement.ts";
import { canonicalDigest } from "../shared/encoding.ts";

const args = parseArgs(process.argv.slice(2));
const command = process.argv[2];
const ctx = connectAgent("BUYER_KEY", args.runtime);
const me = "buyer";

function readPack(path: string | undefined): AcceptancePack {
  if (!path) throw new Error("--pack <file> is required. A job without an approved agreement cannot be validated.");
  return JSON.parse(readFileSync(path, "utf8")) as AcceptancePack;
}

function refuse(action: string, reason: string, summary: string): never {
  say(me, `refusing to ${action}:`);
  for (const line of summary.split("\n")) say(me, `  ${line}`);
  emit({ agent: me, action, ok: false, reason, issues: summary });
  process.exit(2);
}

if (command === "create") {
  const pack = readPack(args.pack);
  const source = loadFixture(args.source ?? "source-batch-1.json");

  say(me, `preparing a job from pack "${pack.title}" v${pack.packVersion}`);
  const structure = validatePackStructure(pack);
  if (!structure.ok) refuse("create", structure.issues[0]!.code, structure.summary);
  say(me, "pack structure validated: four executable clauses, all matching the supported template");

  if (canonicalDigest(source) !== pack.sourceDigest) {
    refuse("create", "SOURCE_DIGEST_MISMATCH",
      `The pack names source batch ${pack.sourceDigest}, but the batch I am about to submit hashes to ${canonicalDigest(source)}.`);
  }

  const approvedToken: string = await (ctx.escrow as any).paymentToken();
  const approvedDecimals = Number(await (ctx.token as any).decimals());
  if (approvedToken.toLowerCase() !== pack.payment.paymentToken.toLowerCase()) {
    refuse("create", "APPROVED_TOKEN_MISMATCH",
      `The pack pays in ${pack.payment.paymentToken}, but this escrow only ever moves ${approvedToken}.`);
  }

  const created = await jobs.createJob({
    escrow: ctx.escrow,
    buyer: ctx.wallet,
    provider: args.provider!,
    token: approvedToken,
    amount: BigInt(args.amount ?? pack.payment.amountBaseUnits),
    source,
    pack,
    deliveryWindowSeconds: Number(args.delivery ?? pack.payment.deliveryWindowSeconds),
    settlementWindowSeconds: Number(args.settlement ?? pack.payment.settlementWindowSeconds),
  });

  // Confirm that what landed on chain is what was intended, before telling anyone it exists.
  const onChain = await jobs.readJob(ctx.escrow, created.jobId);
  const verified = await jobs.verifyTermsIndependently(ctx.escrow, created.jobId, BigInt(ctx.runtime.chainId));
  const agreement = validateAgreement({
    pack,
    terms: verified.terms,
    storedTermsDigest: verified.chainDigest,
    createdAt: onChain.createdAt,
    sourceRows: onChain.source,
    expect: {
      role: "buyer", address: ctx.wallet.address, approvedPaymentToken: approvedToken,
      approvedTokenDecimals: approvedDecimals,
      chainId: BigInt(ctx.runtime.chainId), escrow: ctx.runtime.addresses.escrow,
    },
  });
  if (!agreement.ok) refuse("create", agreement.issues[0]!.code, agreement.summary);

  say(me, `created job ${created.jobId}, terms digest ${created.termsDigest.slice(0, 18)}…`);
  emit({ agent: me, action: "create", ok: true, ...created });
} else if (command === "fund") {
  const pack = readPack(args.pack);
  const jobId = BigInt(args.job!);
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
      role: "buyer", address: ctx.wallet.address, approvedPaymentToken: approvedToken,
      approvedTokenDecimals: approvedDecimals,
      chainId: BigInt(ctx.runtime.chainId), escrow: ctx.runtime.addresses.escrow,
    },
  });
  if (!agreement.ok) refuse("fund", agreement.issues[0]!.code, agreement.summary);

  say(me, `agreement validated against the stored terms; funding ${verified.terms.amount} base units of ${approvedToken}`);
  const res = await jobs.fundJob(ctx.escrow, ctx.token, ctx.wallet, jobId, verified.chainDigest, verified.terms.amount);
  say(me, `escrow funded in ${res.fund.hash.slice(0, 18)}…`);
  emit({ agent: me, action: "fund", ok: true, jobId, ...res });
} else {
  throw new Error(`Unknown buyer command: ${command}. Use "create" or "fund".`);
}
