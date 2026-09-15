#!/usr/bin/env node
/**
 * Comparable gas and timing measurements for three settlement paths.
 *
 * Deliberately shaped to line up with the independent review's table of 14 September 2026:
 * a fresh disposable chain, three successful jobs at each of 12 and 32 records, medians reported.
 * Deployment, UI rendering, agent-process startup and pack authoring are excluded.
 *
 *   baseline    create, accept, approve+fund, submitDelivery, settle       (two transactions to finish)
 *   combined    create, accept, approve+fund, submitAndSettle              (one transaction to finish)
 *   experiment  the same as combined on CommitmentEscrowExperiment, which stores commitments
 *               rather than rows and is handed the rows at settlement
 *
 * The local chain mines immediately at zero gas price. These are development measurements. They
 * are not public-network latency, not a cost in money, and not a comparison with anything else.
 *
 * Usage: npm run benchmark
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ContractFactory, parseUnits, type Contract } from "ethers";
import { startLocalChain, deployAll } from "../src/chain/chain.ts";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";
import * as jobs from "../src/chain/jobs.ts";
import { buildPack, packDigest } from "../src/shared/pack.ts";
import { transform } from "../src/agents/common.ts";
import { check } from "../src/shared/policy.ts";
import type { RecordRow } from "../src/shared/types.ts";

const REPEATS = 3;
const SIZES = [12, 32];
const AMOUNT = parseUnits("25", 6);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const medianBig = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2n;
};

const chain = await startLocalChain();
const dep = await deployAll(chain);
const token = dep.token as any;
for (const role of ["buyer", "provider", "thirdParty"] as const) {
  await (await token.mint(chain.addresses[role], parseUnits("100000", 6))).wait();
}

// The experiment is deployed here and nowhere else. The application never touches it.
const expArt = chain.artifacts.contracts["CommitmentEscrowExperiment"]!;
const experiment = (await new ContractFactory(expArt.abi, expArt.bytecode, chain.wallets.deployer)
  .deploy(dep.addresses.policy, dep.addresses.token)) as unknown as Contract;
await experiment.waitForDeployment();
const experimentAddress = await experiment.getAddress();

const rowsFor = (n: number): RecordRow[] =>
  Array.from({ length: n }, (_, i) => ({ productId: BigInt(n - i), priceCents: BigInt(1000 + i) }));

interface Run { path: string; n: number; wallMs: number; gas: Record<string, bigint>; totalGas: bigint; txCount: number }
const runs: Run[] = [];

async function baseline(n: number, twoStep: boolean): Promise<Run> {
  const source = rowsFor(n);
  const output = transform(source);
  const pack = buildPack({
    title: `bench ${n}`,
    source,
    payment: {
      tokenSymbol: "mUSD", paymentToken: dep.addresses.token, tokenDecimals: 6,
      amountBaseUnits: AMOUNT.toString(), deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
    },
  });
  const gas: Record<string, bigint> = {};
  const t0 = performance.now();

  const created = await jobs.createJob({
    escrow: dep.escrow, buyer: chain.wallets.buyer, provider: chain.addresses.provider,
    token: dep.addresses.token, amount: AMOUNT, source, pack,
    deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
  });
  gas.create = BigInt(created.tx.gasUsed);
  gas.accept = BigInt((await jobs.acceptJob(dep.escrow, chain.wallets.provider, created.jobId, created.termsDigest)).gasUsed);
  const funded = await jobs.fundJob(dep.escrow, dep.token, chain.wallets.buyer, created.jobId, created.termsDigest, AMOUNT);
  gas.approve = BigInt(funded.approve.gasUsed);
  gas.fund = BigInt(funded.fund.gasUsed);

  let txCount = 4;
  if (twoStep) {
    gas.submit = BigInt((await jobs.submitDelivery(dep.escrow, chain.wallets.provider, created.jobId, output)).gasUsed);
    gas.settle = BigInt((await jobs.settle(dep.escrow, chain.wallets.thirdParty, created.jobId)).gasUsed);
    txCount = 6;
  } else {
    gas.submitAndSettle = BigInt((await jobs.submitAndSettle(dep.escrow, chain.wallets.provider, created.jobId, output)).gasUsed);
    txCount = 5;
  }
  const wallMs = performance.now() - t0;
  const final = await jobs.readJob(dep.escrow, created.jobId);
  if (final.status !== "PAID") throw new Error(`benchmark job did not pay: ${final.status}`);
  return { path: twoStep ? "baseline (two-step)" : "combined (submitAndSettle)", n, wallMs, gas, totalGas: sum(gas), txCount };
}

async function experimentRun(n: number): Promise<Run> {
  const source = rowsFor(n);
  const output = transform(source);
  const pack = buildPack({
    title: `bench-exp ${n}`,
    source,
    payment: {
      tokenSymbol: "mUSD", paymentToken: dep.addresses.token, tokenDecimals: 6,
      amountBaseUnits: AMOUNT.toString(), deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
    },
  });
  const gas: Record<string, bigint> = {};
  const tuples = jobs.toTuples(source);
  const outTuples = jobs.toTuples(output);
  const t0 = performance.now();

  const asBuyer = experiment.connect(chain.wallets.buyer) as any;
  const createTx = await asBuyer.createJob({
    provider: chain.addresses.provider, amount: AMOUNT, requiredRowCount: n, ruleMask: 0x0f,
    packDigest: packDigest(pack), unsupportedClauseCount: 0,
    deliveryWindowSeconds: 600, settlementWindowSeconds: 600,
  }, tuples);
  const createReceipt = await createTx.wait();
  gas.create = createReceipt.gasUsed;
  const jobId = BigInt(await (experiment as any).jobCount());

  gas.accept = (await (await (experiment.connect(chain.wallets.provider) as any).acceptJob(jobId)).wait()).gasUsed;
  gas.approve = (await (await (dep.token.connect(chain.wallets.buyer) as any).approve(experimentAddress, AMOUNT)).wait()).gasUsed;
  gas.fund = (await (await (experiment.connect(chain.wallets.buyer) as any).fundJob(jobId)).wait()).gasUsed;
  gas.submitAndSettle = (await (await (experiment.connect(chain.wallets.provider) as any)
    .submitAndSettle(jobId, tuples, outTuples)).wait()).gasUsed;

  const wallMs = performance.now() - t0;
  const final = await (experiment as any).getJob(jobId);
  if (Number(final.status) !== 5) throw new Error(`experiment job did not pay: status ${final.status}`);
  return { path: "experiment (commitments only)", n, wallMs, gas, totalGas: sum(gas), txCount: 5 };
}

function sum(gas: Record<string, bigint>) {
  return Object.values(gas).reduce((a, b) => a + b, 0n);
}

// --------------------------------------------------------------- microbenchmarks
const micro: Record<string, { checkMs: number; transformMs: number }> = {};
for (const n of SIZES) {
  const source = rowsFor(n);
  const output = transform(source);
  for (let i = 0; i < 200; i++) { transform(source); check(source, output, n); }
  let t = performance.now();
  for (let i = 0; i < 10000; i++) transform(source);
  const transformMs = (performance.now() - t) / 10000;
  t = performance.now();
  for (let i = 0; i < 10000; i++) check(source, output, n);
  const checkMs = (performance.now() - t) / 10000;
  micro[n] = { checkMs, transformMs };
}

// --------------------------------------------------------------------- run it
console.log(bold("\nAcceptance MVP — settlement path benchmark"));
console.log(dim("Fresh disposable local chain, instant mining, zero gas price. Development measurements only.\n"));

for (const n of SIZES) {
  for (let r = 0; r < REPEATS; r++) {
    runs.push(await baseline(n, true));
    runs.push(await baseline(n, false));
    runs.push(await experimentRun(n));
  }
}

const paths = ["baseline (two-step)", "combined (submitAndSettle)", "experiment (commitments only)"];
const summary: any[] = [];

for (const n of SIZES) {
  console.log(bold(`${n} records`));
  console.log(
    "  " + "path".padEnd(32) + "txs".padStart(5) + "median wall".padStart(14) +
    "median total gas".padStart(19) + "finish gas".padStart(13) + "vs baseline".padStart(13),
  );
  const baselineTotal = medianBig(runs.filter((x) => x.n === n && x.path === paths[0]).map((x) => x.totalGas));
  for (const path of paths) {
    const rs = runs.filter((x) => x.n === n && x.path === path);
    const totalGas = medianBig(rs.map((x) => x.totalGas));
    const wall = median(rs.map((x) => x.wallMs));
    // "finish gas" is what it costs to go from a funded job to a settled one.
    const finishGas = medianBig(rs.map((x) =>
      (x.gas.submit ?? 0n) + (x.gas.settle ?? 0n) + (x.gas.submitAndSettle ?? 0n)));
    const delta = Number(totalGas - baselineTotal) / Number(baselineTotal) * 100;
    console.log(
      "  " + path.padEnd(32) + String(rs[0]!.txCount).padStart(5) +
      `${wall.toFixed(0)} ms`.padStart(14) +
      totalGas.toLocaleString().padStart(19) +
      finishGas.toLocaleString().padStart(13) +
      (path === paths[0] ? "—".padStart(13) : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`.padStart(13)),
    );
    summary.push({
      records: n, path, transactions: rs[0]!.txCount,
      medianWallMs: Number(wall.toFixed(2)),
      medianTotalGas: totalGas.toString(),
      medianFinishGas: finishGas.toString(),
      perStepMedianGas: Object.fromEntries(
        Object.keys(rs[0]!.gas).map((k) => [k, medianBig(rs.map((x) => x.gas[k] ?? 0n)).toString()]),
      ),
      changeVsBaselinePercent: path === paths[0] ? 0 : Number(delta.toFixed(1)),
    });
  }
  console.log(dim(`  local checker ${micro[n]!.checkMs.toFixed(5)} ms/call, supplier transform ${micro[n]!.transformMs.toFixed(5)} ms/call (10,000 calls)\n`));
}

mkdirSync(join(PROJECT_ROOT, "evidence"), { recursive: true });
writeFileSync(join(PROJECT_ROOT, "evidence", "benchmark.json"), JSON.stringify({
  ranAt: new Date().toISOString(),
  repeats: REPEATS,
  chainId: chain.chainId,
  solcVersion: chain.artifacts.solcVersion,
  contractSourcesHash: chain.artifacts.sourcesHash,
  microbenchmarks: micro,
  results: summary,
  caveats: [
    "Local Ganache with instant mining and zero gas price. Not public-network latency and not a cost in money.",
    "Excludes deployment, UI rendering, agent-process startup and acceptance-pack authoring.",
    "The experiment path is not used by the application. It exists to be measured.",
    "Sorting this fixture is cheaper than checking it. These timings describe a demonstration fixture, not a business case.",
  ],
}, null, 2));

console.log(dim(`  results -> evidence/benchmark.json\n`));
await chain.close();
