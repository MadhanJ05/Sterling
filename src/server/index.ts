/**
 * Local demo server. Binds to loopback only.
 *
 * Every route is a named demo action. There is deliberately no endpoint that signs arbitrary
 * data, no endpoint that takes a verdict, and no endpoint that returns a private key. The demo
 * accounts live in this process's memory and never reach the browser, the logs or disk.
 */
import express, { type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST } from "../chain/chain.ts";
import { Session } from "../chain/session.ts";
import { runBlockedAction } from "../chain/blocked.ts";
import { PROJECT_ROOT, loadFixture } from "../chain/fixtures.ts";
import { SCENARIOS, BLOCKED_ACTIONS } from "../shared/scenarios.ts";
import { coverage, packDigest } from "../shared/pack.ts";
import { check } from "../shared/policy.ts";
import { verifyBundle } from "../shared/evidence.ts";
import { RULES } from "../shared/types.ts";
import { API_VERSION } from "../shared/apiVersion.ts";

const PORT = Number(process.env.PORT ?? 5173);
const DEV = process.argv.includes("--dev") || process.env.NODE_ENV !== "production";

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * Refuse to start before doing any work if the port is taken.
 *
 * Previously this booted a chain, deployed three contracts and only then discovered the conflict —
 * printing a "listening" banner immediately before the failure. Worse, the older server kept
 * answering, so a browser loaded this page from disk and talked to stale routes, and the only
 * symptom was an unreadable parse error when a button was pressed.
 */
async function assertPortFree(host: string, port: number): Promise<void> {
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, host);
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`\n  Cannot start: port ${port} is already in use.`);
    console.error("  Something is already serving that port — almost always an earlier run of this");
    console.error("  server that is still alive. A browser pointed at it will load this page but talk");
    console.error("  to the old routes, which fails only when you press something.\n");
    console.error(`    see it:   lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`    stop it:  kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)`);
    console.error(`    or:       PORT=${port + 10} npm start\n`);
    process.exit(1);
  });
}

await assertPortFree(HOST, PORT);

console.log("Starting a disposable local chain and deploying the contracts…");
const session = await Session.start();
console.log(`  chain id ${session.chain.chainId}`);
console.log(`  escrow   ${session.dep.addresses.escrow}`);
console.log(`  policy   ${session.dep.addresses.policy}`);
console.log(`  token    ${session.dep.addresses.token}`);

const app = express();
app.use(express.json({ limit: "256kb" }));

/** Turns a thrown revert into a structured 400 rather than a stack trace. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(json(await fn(req, res)));
  } catch (e: any) {
    if (e?.name === "ScopeRevisionRequired") {
      res.status(400).json(json({
        error: "ScopeRevisionRequired",
        message: e.message,
        preview: {
          revisedPackDigest: e.preview.revisedPackDigest,
          revisedPack: e.preview.revised,
          reason: e.preview.reason,
          coverage: e.preview.coverage,
        },
      }));
      return;
    }
    const { decodeRevert } = await import("../chain/jobs.ts");
    const decoded = decodeRevert(session.dep.escrow, e);
    res.status(400).json({
      error: decoded.name === "UNKNOWN" ? (e?.shortMessage ?? e?.message ?? String(e)) : decoded.name,
      args: decoded.args,
      message: e?.shortMessage ?? e?.message ?? String(e),
    });
  }
};

/** Express 5 types a route param as string | string[]; demo ids are always a single segment. */
function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(v) ? v[0]! : String(v);
}

async function jobDetail(jobId: string) {
  const session_job = session.jobsById.get(jobId);
  if (!session_job) throw new Error(`This session has no job ${jobId}`);
  const onChain = await session.readJob(jobId);
  const observed = await session.observedTransfersFor(jobId);
  const cov = coverage(session_job.pack);
  const localPreview = onChain.output.length
    ? check(onChain.source, onChain.output, onChain.terms.requiredRowCount, onChain.terms.ruleMask)
    : null;
  return {
    ...session_job,
    onChain,
    // Derived from this job's own receipts. The UI must not subtract wallet balances: another
    // job completing would silently change what this one appears to have paid.
    observedTransfers: observed,
    balanceDeltas: Session.deltasFrom(observed, {
      ...session.chain.addresses, escrow: session.dep.addresses.escrow,
    }),
    coverage: cov,
    packDigestRecomputed: packDigest(session_job.pack),
    localPreview,
    now: await session.chain.now(),
  };
}

// ------------------------------------------------------------------ read-only

app.get("/api/state", route(async () => ({
  apiVersion: API_VERSION,
  chain: {
    chainId: session.chain.chainId,
    label: "disposable local chain (Ganache, in-process)",
    addresses: session.dep.addresses,
    roles: session.chain.addresses,
    solcVersion: session.chain.artifacts.solcVersion,
    contractSourcesHash: session.chain.artifacts.sourcesHash,
    now: await session.chain.now(),
    timeSkewSeconds: session.timeSkewSeconds,
  },
  token: { symbol: "mUSD", decimals: 6 },
  rules: RULES,
  scenarios: SCENARIOS,
  blockedActions: BLOCKED_ACTIONS,
  balances: await session.balances(),
  topUps: session.topUps,
  jobs: await Promise.all([...session.jobsById.keys()].map(async (id) => {
    const j = session.jobsById.get(id)!;
    const onChain = id.startsWith("blocked-") ? null : await session.readJob(id);
    return { jobId: id, scenarioId: j.scenarioId, status: onChain?.status ?? "BLOCKED_AT_CREATION", driver: j.driver };
  })),
})));

app.get("/api/job/:id", route(async (req) => jobDetail(param(req, "id"))));

app.get("/api/job/:id/evidence", route(async (req) => {
  const bundle = await session.exportEvidence(param(req, "id"));
  return { bundle, verification: verifyBundle(bundle) };
}));

app.get("/api/pack/:scenarioId", route(async (req) => {
  const id = param(req, "scenarioId");
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}`);
  const source = loadFixture(scenario.sourceFixture);
  const pack = session.packFor(scenario, source);
  // The revision preview is what a caller must approve by digest before any job can be created.
  const preview = session.previewScopeRevision(id);
  return {
    pack, coverage: coverage(pack), packDigest: packDigest(pack), source,
    revision: {
      needed: preview.needsRevision,
      revisedPack: preview.revised,
      revisedPackDigest: preview.revisedPackDigest,
      reason: preview.reason,
    },
  };
}));

app.get("/api/fixture/:name", route(async (req) => {
  const rows = loadFixture(param(req, "name"));
  return { name: param(req, "name"), rows };
}));

// --------------------------------------------------------- named demo actions

/**
 * Create a job. A scope revision is never implicit: the caller must pass back the digest of the
 * exact revised pack it has read, which `/api/pack/:scenarioId` returns.
 */
app.post("/api/job/create", route(async (req) => {
  const { scenarioId, approvedPackDigest, revisionReason } = req.body ?? {};
  const job = await session.createJob(String(scenarioId), approvedPackDigest
    ? { revision: { approvedPackDigest: String(approvedPackDigest), reason: String(revisionReason ?? "") } }
    : {});
  return jobDetail(job.jobId);
}));

app.post("/api/job/:id/accept", route(async (req) => { await session.accept(param(req, "id")); return jobDetail(param(req, "id")); }));
app.post("/api/job/:id/fund", route(async (req) => { await session.fund(param(req, "id")); return jobDetail(param(req, "id")); }));
app.post("/api/job/:id/submit", route(async (req) => { await session.submit(param(req, "id")); return jobDetail(param(req, "id")); }));
app.post("/api/job/:id/settle", route(async (req) => { await session.settle(param(req, "id")); return jobDetail(param(req, "id")); }));
app.post("/api/job/:id/refund", route(async (req) => { await session.refundExpired(param(req, "id")); return jobDetail(param(req, "id")); }));

app.post("/api/job/:id/advance-time", route(async (req) => {
  const seconds = Math.max(1, Math.min(86400, Number(req.body?.seconds ?? 60)));
  await session.advanceTime(seconds);
  return jobDetail(param(req, "id"));
}));

app.post("/api/agents/run", route(async (req) => {
  const lines: string[] = [];
  const job = await session.runAgents(String(req.body?.scenarioId), (l) => lines.push(l.trim()));
  return { log: lines, job: job.jobId.startsWith("blocked-") ? { ...job, onChain: null } : await jobDetail(job.jobId) };
}));

/**
 * Import a small batch of rows and reuse the fixed template for it. This is the one place the
 * interface accepts data that did not come from a committed fixture, so it goes through the same
 * strict import boundary and reports every issue rather than silently keeping what parsed.
 */
app.post("/api/job/import", route(async (req) => {
  const { importRecordsFromJson } = await import("../shared/importJson.ts");
  const parsed = importRecordsFromJson(String(req.body?.rows ?? ""));
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const job = await session.createJobFromRows(parsed.rows, String(req.body?.title ?? "Imported batch"));
  return { ok: true, job: await jobDetail(job.jobId) };
}));

/**
 * Runs an entire job start to finish and returns a log of the steps **once it has finished**.
 * This is not a stream; there are no progress events. The interface shows a busy indicator while
 * it waits and then renders the completed log.
 *
 * An unsupported-scope scenario is refused here, before anything is created, unless the caller
 * supplies an approved revised-pack digest.
 */
app.post("/api/job/auto", route(async (req) => {
  const log: string[] = [];
  const { scenarioId, approvedPackDigest, revisionReason } = req.body ?? {};
  const job = await session.runAutomatic(String(scenarioId ?? "pass"), (l) => log.push(l), approvedPackDigest
    ? { revision: { approvedPackDigest: String(approvedPackDigest), reason: String(revisionReason ?? "") } }
    : {});
  return { log, job: await jobDetail(job.jobId) };
}));

/** The same automatic path for a job that already exists, such as an imported batch. */
app.post("/api/job/:id/auto", route(async (req) => {
  const log: string[] = [];
  await session.runAutomaticForJob(param(req, "id"), (l) => log.push(l));
  return { log, job: await jobDetail(param(req, "id")) };
}));

app.post("/api/blocked/:id", route(async (req) => runBlockedAction(session, param(req, "id"))));

// ------------------------------------------------------------------ web assets

if (DEV) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: join(PROJECT_ROOT, "src", "web"),
    // The HMR websocket is a separate listener from this express server and must be bound
    // explicitly; middlewareMode does not inherit the host below.
    server: { middlewareMode: true, host: HOST, hmr: { host: HOST, port: PORT + 1 } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const dist = join(PROJECT_ROOT, "dist");
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.send(readFileSync(join(dist, "index.html"), "utf8")));
}

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`\n  Open  http://${HOST}:${PORT}`);
  console.log(`  API   ${API_VERSION}\n`);
  console.log("  Local simulation · synthetic data · test funds · all participants operator-controlled");
  console.log("  Press Ctrl+C to stop. The chain and every job on it disappear with this process.\n");
});

/**
 * A port conflict used to kill this process quietly while an older server kept answering on the
 * same port. The page then hot-reloaded from disk against stale routes, and the only symptom was
 * an unreadable parse error when a button was pressed. Say exactly what is wrong and how to clear
 * it, and exit non-zero so `npm start` cannot look like it succeeded.
 */
/** Backstop for a race between the probe above and this listen. */
httpServer.on("error", async (e: NodeJS.ErrnoException) => {
  console.error(`\n  Cannot start: ${e.code === "EADDRINUSE" ? `port ${PORT} was taken between the check and the bind` : e.message}\n`);
  await session.close().catch(() => {});
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log("\nShutting the local chain down.");
    await session.close();
    process.exit(0);
  });
}
