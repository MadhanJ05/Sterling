#!/usr/bin/env node
/**
 * Verification of an exported evidence bundle.
 *
 * Three separate questions, three separate verdicts, never collapsed into one reassuring line:
 *
 *   1. rules reproduced            — offline, always run
 *   2. bundle internally consistent — offline, always run
 *   3. on-chain settlement          — only with --rpc; otherwise reported NOT CHECKED
 *
 * The third is the one that matters for a payment claim, and it is the one an earlier version got
 * wrong: it checked that each recorded transaction had a successful receipt, which an unrelated
 * token mint on a different chain also satisfies. It now checks the network, the deployed
 * contracts, the destination of every transaction, the escrow's own events for this job id and
 * verdict, and the token transfer events for the exact asset, recipient and amount — for funding
 * as well as payout.
 *
 * Usage: npm run verify -- evidence/demo/job-1-pass.json [--rpc <url>] [--min-confirmations n]
 */
import { readFileSync } from "node:fs";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import { rowsIn, verifyBundle, type EvidenceBundle, type VerificationLine } from "../src/shared/evidence.ts";
import { canonicalDigest } from "../src/shared/encoding.ts";
import { deriveMovements } from "../src/shared/transfers.ts";
import { loadArtifacts } from "../src/chain/compile.ts";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--") && !isValueOf(args, a));
const rpc = valueOf("--rpc");
const minConfirmations = Number(valueOf("--min-confirmations") ?? 1);

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function isValueOf(all: string[], token: string): boolean {
  const i = all.indexOf(token);
  return i > 0 && all[i - 1]!.startsWith("--");
}

if (!path) {
  console.error("Usage: npm run verify -- <bundle.json> [--rpc <url>] [--min-confirmations n]");
  console.error("A bundle path is required; this command does not verify every bundle it can find.");
  process.exit(2);
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const bundle = JSON.parse(readFileSync(path, "utf8")) as EvidenceBundle;
const report = verifyBundle(bundle);

console.log(bold(`\nEvidence bundle: ${path}`));
console.log(dim(`job ${bundle.job?.jobId} on chain ${bundle.chain?.chainId}, status ${bundle.job?.status}, exported ${bundle.exportedAt}\n`));

function printSection(title: string, verdict: string, lines: VerificationLine[], note?: string) {
  const badge = verdict === "PASS" ? green("PASS") : verdict === "FAIL" ? red("FAIL") : yellow("NOT CHECKED");
  console.log(`${bold(title.toUpperCase())}  ${badge}`);
  for (const l of lines) {
    console.log(`${l.ok ? green("  ✓") : red("  ✗")} ${l.name}`);
    console.log(dim(`      ${l.detail}`));
  }
  if (note) console.log(dim(`      ${note}`));
  console.log();
}

for (const section of report.sections) {
  if (section.key === "settlementVerified") continue;
  printSection(section.title, section.verdict, section.lines);
}

// ------------------------------------------------------------- 3. settlement
const settlement: VerificationLine[] = [];
let settlementVerdict: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";
const add = (name: string, ok: boolean, detail: string) => settlement.push({ name, ok, detail });

if (rpc) {
  settlementVerdict = "PASS";
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const artifacts = loadArtifacts();
  const escrowInterface = new Interface(artifacts.contracts["AcceptanceEscrow"]!.abi);
  const tokenInterface = new Interface(artifacts.contracts["MockUSD"]!.abi);

  try {
    const net = await provider.getNetwork();
    add("connected chain is the one the bundle names", Number(net.chainId) === bundle.chain.chainId,
      `rpc reports chain ${net.chainId}; bundle says ${bundle.chain.chainId}`);

    for (const [label, address] of [["escrow", bundle.chain.escrow], ["policy", bundle.chain.policy], ["payment token", bundle.chain.paymentToken]] as const) {
      const code = await provider.getCode(address);
      add(`${label} contract is deployed at the recorded address`, code !== "0x", `${address} has ${(code.length - 2) / 2} bytes of code`);
    }

    // The escrow must agree that it uses this payment token and this policy.
    const escrow = new Contract(bundle.chain.escrow, artifacts.contracts["AcceptanceEscrow"]!.abi, provider);
    try {
      const onChainToken: string = await (escrow as any).paymentToken();
      const onChainPolicy: string = await (escrow as any).policy();
      add("the deployed escrow uses the recorded payment token",
        onChainToken.toLowerCase() === bundle.chain.paymentToken.toLowerCase(), `${onChainToken}`);
      add("the deployed escrow uses the recorded policy",
        onChainPolicy.toLowerCase() === bundle.chain.policy.toLowerCase(), `${onChainPolicy}`);

      const tokenContract = new Contract(bundle.chain.paymentToken, artifacts.contracts["MockUSD"]!.abi, provider);
      const onChainDecimals = Number(await (tokenContract as any).decimals());
      add("the token's precision matches the agreement", onChainDecimals === bundle.pack.payment.tokenDecimals,
        `token reports ${onChainDecimals}, pack says ${bundle.pack.payment.tokenDecimals}`);
    } catch (e) {
      add("the deployed escrow answers as an AcceptanceEscrow", false, (e as Error).message);
    }

    // ---- The decisive comparison: the bundle's own commitments against the stored job ----
    //
    // Everything else in this section proves that *a* payment happened. Only this proves it was a
    // payment for *this* work. Without it, genuine receipts authenticate any internally consistent
    // fabrication: rewrite the source and delivery rows, recompute every dependent hash, keep the
    // real job id and receipts, and the rest of the checks still pass.
    const jobIdBig = BigInt(bundle.job.jobId);
    try {
      const stored = await (escrow as any).getJob(jobIdBig);
      const st = stored.terms;
      const statusName = [
        "NONE", "CREATED", "ACCEPTED", "FUNDED", "SUBMITTED", "PAID", "REJECTED", "EXPIRED", "CANCELLED",
      ][Number(stored.status)] ?? "NONE";

      const cmp = (name: string, actual: unknown, expected: unknown) =>
        add(name, String(actual).toLowerCase() === String(expected).toLowerCase(),
          `chain ${actual} / bundle ${expected}`);

      cmp("stored terms digest matches the bundle", stored.termsDigest, bundle.commitments.termsDigest);
      cmp("stored source commitment matches the bundle", st.sourceDigest, bundle.commitments.sourceDigest);
      cmp("stored pack commitment matches the bundle", st.packDigest, bundle.commitments.packDigest);
      cmp("stored delivery commitment matches the bundle", stored.deliveryDigest, bundle.commitments.deliveryDigest);
      cmp("stored buyer matches the bundle", st.buyer, bundle.job.buyer);
      cmp("stored supplier matches the bundle", st.provider, bundle.job.provider);
      cmp("stored payment token matches the bundle", st.paymentToken, bundle.chain.paymentToken);
      cmp("stored amount matches the bundle", st.amount, bundle.job.amountBaseUnits);
      cmp("stored row count matches the bundle", st.requiredRowCount, bundle.terms.requiredRowCount);
      cmp("stored policy matches the bundle", st.policyId, bundle.terms.policyId);
      cmp("stored policy version matches the bundle", st.policyVersion, bundle.terms.policyVersion);
      cmp("stored rule mask matches the bundle", st.ruleMask, bundle.terms.ruleMask);
      cmp("stored delivery deadline matches the bundle", st.deliveryDeadline, bundle.job.deliveryDeadline);
      cmp("stored settlement expiry matches the bundle", st.settlementExpiry, bundle.job.settlementExpiry);
      cmp("stored status matches the bundle", statusName, bundle.job.status);
      // Timestamps are content too. Without these, a bundle can claim work was delivered a day
      // after the deadline and settled later still, and everything else still lines up.
      cmp("stored creation time matches the bundle", stored.createdAt, bundle.job.createdAt);
      cmp("stored submission time matches the bundle", stored.submittedAt, bundle.job.submittedAt);
      cmp("stored settlement time matches the bundle", stored.settledAt, bundle.job.settledAt);
      cmp("stored verdict matches the bundle", stored.verdict, bundle.recordedVerdict.verdict);
      cmp("stored failing rule matches the bundle", stored.ruleId, bundle.recordedVerdict.ruleId);
      cmp("stored fail code matches the bundle", stored.failCode, bundle.recordedVerdict.failCode);
      cmp("stored verdict detail matches the bundle", stored.detailA, bundle.recordedVerdict.detailA);
      cmp("stored verdict detail matches the bundle (second value)", stored.detailB, bundle.recordedVerdict.detailB);

      // And the rows themselves, not only their digests.
      const storedSource = await (escrow as any).getSource(jobIdBig);
      const storedSourceRows = storedSource.map((r: any) => ({ productId: BigInt(r[0]), priceCents: BigInt(r[1]) }));
      add("the bundle's source rows are the rows the contract stored",
        canonicalDigest(storedSourceRows) === canonicalDigest(rowsIn(bundle.source)),
        `${storedSourceRows.length} stored row(s)`);

      const storedOutput = await (escrow as any).getOutput(jobIdBig);
      const storedOutputRows = storedOutput.map((r: any) => ({ productId: BigInt(r[0]), priceCents: BigInt(r[1]) }));
      add("the bundle's delivered rows are the rows the contract stored",
        canonicalDigest(storedOutputRows) === canonicalDigest(rowsIn(bundle.delivery ?? [])),
        `${storedOutputRows.length} stored row(s)`);
    } catch (e) {
      add("the stored job could be read and compared", false, (e as Error).message);
    }

    // Every recorded transaction must exist, have succeeded, be confirmed, and be addressed to a
    // contract this bundle actually names. Unrelated transactions are rejected outright.
    const known = new Map<string, string>([
      [bundle.chain.escrow.toLowerCase(), "escrow"],
      [bundle.chain.paymentToken.toLowerCase(), "payment token"],
    ]);
    const head = await provider.getBlockNumber();
    const seen = new Set<string>();
    if (!bundle.transactions?.length) {
      add("the bundle records at least one transaction", false, "no transactions recorded, so no settlement can be established");
    }
    for (const t of bundle.transactions ?? []) {
      if (seen.has(t.hash)) {
        add(`transaction ${t.step}`, false, `duplicate hash ${t.hash}`);
        continue;
      }
      seen.add(t.hash);
      const receipt = await provider.getTransactionReceipt(t.hash);
      if (!receipt) { add(`transaction ${t.step}`, false, `no receipt on this chain for ${t.hash}`); continue; }
      const target = (receipt.to ?? "").toLowerCase();
      const confirmations = head - receipt.blockNumber + 1;

      // A successful receipt proves only that *something* happened. It must also be about this
      // job: either an escrow event carrying this job id, or a payment-token movement involving
      // the escrow. An unrelated mint on the same token satisfies neither.
      const jobTopicHex = "0x" + BigInt(bundle.job.jobId).toString(16).padStart(64, "0");
      const relatesToJob = receipt.logs.some((l) => {
        const addr = l.address.toLowerCase();
        if (addr === bundle.chain.escrow.toLowerCase()) return l.topics[1] === jobTopicHex;
        if (addr === bundle.chain.paymentToken.toLowerCase()) {
          return l.topics.some((topic) => topic.toLowerCase().endsWith(bundle.chain.escrow.slice(2).toLowerCase()));
        }
        return false;
      });

      const ok =
        receipt.status === 1 &&
        receipt.blockNumber === t.blockNumber &&
        known.has(target) &&
        relatesToJob &&
        confirmations >= minConfirmations;
      add(`transaction ${t.step}`, ok,
        `${t.hash} -> ${known.get(target) ?? `UNRELATED CONTRACT ${receipt.to}`}, block ${receipt.blockNumber}` +
        `${receipt.blockNumber === t.blockNumber ? "" : ` (bundle says ${t.blockNumber})`}` +
        `${relatesToJob ? "" : ", NOT RELATED TO THIS JOB"}, ${confirmations} confirmation(s)`);
    }

    // Recompute this job's cash movements from the chain and compare with what the bundle claims.
    // Nothing is assumed about the expected amount: the receipts are read and added up.
    try {
      const escrowLower = bundle.chain.escrow.toLowerCase();
      const tokenLower = bundle.chain.paymentToken.toLowerCase();
      const seenTx = new Set<string>();
      const chainTransfers: { txHash: string; logIndex: number; from: string; to: string; value: bigint }[] = [];
      for (const t of bundle.transactions ?? []) {
        if (seenTx.has(t.hash.toLowerCase())) continue;
        seenTx.add(t.hash.toLowerCase());
        const receipt = await provider.getTransactionReceipt(t.hash);
        if (!receipt) continue;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== tokenLower) continue;
          let parsed;
          try { parsed = tokenInterface.parseLog(log as any); } catch { continue; }
          if (!parsed || parsed.name !== "Transfer") continue;
          const from = String(parsed.args.from).toLowerCase();
          const to = String(parsed.args.to).toLowerCase();
          if (from !== escrowLower && to !== escrowLower) continue;
          chainTransfers.push({
            txHash: t.hash, logIndex: log.index,
            from: String(parsed.args.from), to: String(parsed.args.to), value: parsed.args.value,
          });
        }
      }

      const claimed = bundle.observedTransfers?.transfers ?? [];
      const key = (x: { txHash: string; logIndex: number }) => `${x.txHash.toLowerCase()}:${x.logIndex}`;
      const chainKeys = new Set(chainTransfers.map(key));
      const claimedKeys = new Set(claimed.map(key));
      add("the recorded movements are exactly the movements on chain",
        chainKeys.size === claimedKeys.size && [...chainKeys].every((k) => claimedKeys.has(k)),
        `${chainTransfers.length} on chain, ${claimed.length} recorded`);

      const valueMismatch = chainTransfers.filter((c) => {
        const m = claimed.find((x) => key(x) === key(c));
        return !m || BigInt(m.value) !== c.value ||
          m.from.toLowerCase() !== c.from.toLowerCase() || m.to.toLowerCase() !== c.to.toLowerCase();
      });
      add("each recorded movement matches its receipt", valueMismatch.length === 0,
        valueMismatch.length ? `${valueMismatch.length} movement(s) differ from the chain` : "amounts and parties agree");

      // Derive the totals from the chain's own movements, with the same calculation the exporter
      // and the offline checker use — but on a list built here from receipts, so this comparison
      // owes nothing to what the bundle asserts.
      const addrs: Record<string, string> = {
        buyer: bundle.job.buyer, provider: bundle.job.provider, escrow: bundle.chain.escrow,
      };
      const fromChain = deriveMovements(
        chainTransfers.map((t, i) => ({
          txHash: t.txHash, step: "chain", logIndex: t.logIndex,
          from: t.from, to: t.to, value: t.value.toString(),
          direction: t.to.toLowerCase() === bundle.chain.escrow.toLowerCase() ? "in" as const : "out" as const,
        })),
        bundle.chain.escrow,
        addrs,
      );

      const off = Object.entries(fromChain.net)
        .filter(([r, v]) => String(bundle.balanceDeltas?.[r] ?? "0") !== v);
      add("the reported balance changes are what the chain shows for this job", off.length === 0,
        off.length
          ? off.map(([r, v]) => `${r}: bundle ${bundle.balanceDeltas?.[r]} vs chain ${v}`).join("; ")
          : `buyer ${fromChain.net.buyer}, supplier ${fromChain.net.provider}, escrow ${fromChain.net.escrow}`);

      const summaryOff: string[] = [];
      if (String(bundle.observedTransfers?.fundedIn) !== fromChain.fundedIn) {
        summaryOff.push(`fundedIn ${bundle.observedTransfers?.fundedIn} vs chain ${fromChain.fundedIn}`);
      }
      if (String(bundle.observedTransfers?.paidOut) !== fromChain.paidOut) {
        summaryOff.push(`paidOut ${bundle.observedTransfers?.paidOut} vs chain ${fromChain.paidOut}`);
      }
      const bundleTo = bundle.observedTransfers?.paidTo ?? null;
      if ((bundleTo === null) !== (fromChain.paidTo === null) ||
          (bundleTo && fromChain.paidTo && bundleTo.toLowerCase() !== fromChain.paidTo.toLowerCase())) {
        summaryOff.push(`paidTo ${bundleTo} vs chain ${fromChain.paidTo}`);
      }
      add("the reported totals are what the chain shows for this job", summaryOff.length === 0,
        summaryOff.length ? summaryOff.join("; ") : `in ${fromChain.fundedIn}, out ${fromChain.paidOut} to ${fromChain.paidTo}`);
    } catch (e) {
      add("this job's movements could be recomputed from the chain", false, (e as Error).message);
    }

    // The escrow's own log for this job must say what the bundle says.
    const jobId = BigInt(bundle.job.jobId);
    const settledTopic = escrowInterface.getEvent("JobSettled")!.topicHash;
    const expiredTopic = escrowInterface.getEvent("JobExpired")!.topicHash;
    const fundedTopic = escrowInterface.getEvent("JobFunded")!.topicHash;
    const jobTopic = "0x" + jobId.toString(16).padStart(64, "0");

    const logsFor = async (topic: string) =>
      provider.getLogs({ address: bundle.chain.escrow, topics: [topic, jobTopic], fromBlock: 0, toBlock: "latest" });

    const recordedHashes = new Set((bundle.transactions ?? []).map((t) => t.hash.toLowerCase()));
    const inBundle = (hash: string) => recordedHashes.has(hash.toLowerCase());

    const fundedLogs = await logsFor(fundedTopic);
    add("the escrow logged this job being funded", fundedLogs.length === 1,
      fundedLogs.length === 1
        ? `amount ${escrowInterface.parseLog(fundedLogs[0] as any)!.args.amount}`
        : `${fundedLogs.length} JobFunded events for job ${jobId}`);
    if (fundedLogs.length === 1) {
      const parsed = escrowInterface.parseLog(fundedLogs[0] as any)!;
      add("the funded amount matches the bundle", parsed.args.amount.toString() === bundle.job.amountBaseUnits,
        `${parsed.args.amount} vs ${bundle.job.amountBaseUnits}`);
      add("the funding transaction is one the bundle records", inBundle(fundedLogs[0]!.transactionHash),
        `${fundedLogs[0]!.transactionHash}${inBundle(fundedLogs[0]!.transactionHash) ? "" : " is absent from the bundle's transaction list"}`);
    }

    if (bundle.job.status === "EXPIRED") {
      const logs = await logsFor(expiredTopic);
      add("the escrow logged this job expiring", logs.length === 1, `${logs.length} JobExpired event(s)`);
      if (logs.length === 1) {
        add("the expiry transaction is one the bundle records", inBundle(logs[0]!.transactionHash), logs[0]!.transactionHash);
        const parsed = escrowInterface.parseLog(logs[0] as any)!;
        add("the refund went to the buyer named in the bundle",
          parsed.args.refundedTo.toLowerCase() === bundle.job.buyer.toLowerCase(), `${parsed.args.refundedTo}`);
        add("the refunded amount matches the bundle",
          parsed.args.amount.toString() === bundle.job.amountBaseUnits, `${parsed.args.amount}`);

        // The refund branch needs the same asset-movement check as the settlement branch.
        const receipt = await provider.getTransactionReceipt(logs[0]!.transactionHash);
        const moved = (receipt?.logs ?? [])
          .filter((l) => l.address.toLowerCase() === bundle.chain.paymentToken.toLowerCase())
          .map((l) => { try { return tokenInterface.parseLog(l as any); } catch { return null; } })
          .filter((l): l is NonNullable<typeof l> => !!l && l.name === "Transfer")
          .find((t) =>
            t.args.from.toLowerCase() === bundle.chain.escrow.toLowerCase() &&
            t.args.to.toLowerCase() === bundle.job.buyer.toLowerCase() &&
            t.args.value.toString() === bundle.job.amountBaseUnits);
        add("the refund token actually moved that amount back to the buyer", !!moved,
          moved
            ? `Transfer(${bundle.chain.escrow} -> ${bundle.job.buyer}, ${bundle.job.amountBaseUnits})`
            : `no matching Transfer of ${bundle.chain.paymentToken} in ${logs[0]!.transactionHash}`);
      }
    } else {
      const logs = await logsFor(settledTopic);
      add("the escrow logged exactly one settlement for this job", logs.length === 1, `${logs.length} JobSettled event(s)`);
      if (logs.length === 1) {
        // The decisive link: the settlement the chain recorded must be one of the transactions
        // this bundle presents as its evidence. Without this, any bundle could borrow a real
        // settlement that happened elsewhere and pass.
        add("the settlement transaction is one the bundle records", inBundle(logs[0]!.transactionHash),
          `${logs[0]!.transactionHash}${inBundle(logs[0]!.transactionHash) ? "" : " is absent from the bundle's transaction list"}`);
        const parsed = escrowInterface.parseLog(logs[0] as any)!;
        const expectedRecipient = bundle.recordedVerdict.verdict === 1 ? bundle.job.provider : bundle.job.buyer;
        add("the on-chain verdict matches the bundle",
          Number(parsed.args.verdict) === bundle.recordedVerdict.verdict &&
          Number(parsed.args.ruleId) === bundle.recordedVerdict.ruleId,
          `verdict ${parsed.args.verdict}, rule ${parsed.args.ruleId}`);
        add("the payment went to the party the bundle claims",
          parsed.args.paidTo.toLowerCase() === expectedRecipient.toLowerCase(),
          `${parsed.args.paidTo} vs ${expectedRecipient}`);
        add("the settled amount matches the bundle",
          parsed.args.amount.toString() === bundle.job.amountBaseUnits, `${parsed.args.amount}`);

        // And the asset actually moved: a Transfer of the exact amount, of the exact token,
        // from the escrow to that recipient, in that same transaction.
        const receipt = await provider.getTransactionReceipt(logs[0]!.transactionHash);
        const transfers = (receipt?.logs ?? [])
          .filter((l) => l.address.toLowerCase() === bundle.chain.paymentToken.toLowerCase())
          .map((l) => { try { return tokenInterface.parseLog(l as any); } catch { return null; } })
          .filter((l): l is NonNullable<typeof l> => !!l && l.name === "Transfer");
        const matching = transfers.find((t) =>
          t.args.from.toLowerCase() === bundle.chain.escrow.toLowerCase() &&
          t.args.to.toLowerCase() === expectedRecipient.toLowerCase() &&
          t.args.value.toString() === bundle.job.amountBaseUnits);
        add("the payment token actually moved that amount to that recipient", !!matching,
          matching
            ? `Transfer(${bundle.chain.escrow} -> ${expectedRecipient}, ${bundle.job.amountBaseUnits})`
            : `no matching Transfer of ${bundle.chain.paymentToken} in ${logs[0]!.transactionHash}`);
      }
    }
  } catch (e) {
    add("settlement verification completed", false, (e as Error).message);
  }
  if (settlement.some((l) => !l.ok)) settlementVerdict = "FAIL";
  printSection("on-chain settlement", settlementVerdict, settlement,
    "A receipt proves a transaction executed on the chain you pointed at. On a disposable local chain that chain is also operator-controlled, so this is an integrity check, not third-party attestation.");
} else {
  printSection("on-chain settlement", "NOT_CHECKED", [],
    "No --rpc was given, so nothing about an actual payment was checked. Nothing here is evidence that anyone was paid.");
}

console.log(bold("Not established even when all three pass:"));
for (const n of report.notVerified) {
  // Once settlement really has been verified against the chain, repeating "payment was not
  // checked" would contradict the section immediately above it.
  if (settlementVerdict === "PASS" && n.startsWith("Whether any payment actually occurred")) {
    console.log(dim("  · That the chain you pointed at is honest. On a disposable local chain it is operator-controlled, so this is an integrity check, not third-party attestation."));
    continue;
  }
  console.log(dim(`  · ${n}`));
}
if (rpc && minConfirmations < 12) {
  console.log(dim(`  · Confirmation depth was ${minConfirmations}. On a public network, require considerably more before treating a payment as final.`));
}

const offlineOk = report.ok;
const allOk = offlineOk && settlementVerdict === "PASS";
console.log();
if (allOk) console.log(green(bold("rules reproduced · bundle internally consistent · on-chain settlement verified\n")));
else if (offlineOk && settlementVerdict === "NOT_CHECKED") console.log(yellow(bold("rules reproduced · bundle internally consistent · on-chain settlement NOT CHECKED\n")));
else console.log(red(bold("Bundle did NOT verify.\n")));

process.exit(offlineOk && settlementVerdict !== "FAIL" ? 0 : 1);
