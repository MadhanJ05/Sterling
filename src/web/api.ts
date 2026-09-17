export interface Row { productId: string; priceCents: string }

/**
 * One interface, two backends.
 *
 *   server  — the local Node process, which also runs the buyer and provider as separate
 *             operating-system processes and can attempt unauthorized actions against the chain.
 *   static  — the GitHub Pages build, where the same contracts run in an EVM inside this tab.
 *
 * `VITE_STATIC` picks the backend at build time. Anything the static backend cannot honestly do is
 * absent from it rather than emulated; the interface says which build it is running.
 */
export const STATIC_BUILD = import.meta.env.VITE_STATIC === "1";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const raw = await res.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    // Almost always a page that has hot-reloaded past the server process still serving it.
    throw Object.assign(
      new Error(
        `The server replied with HTTP ${res.status} and not JSON. If this page has been open for a ` +
        `while, the running server may be older than the page. Stop it and run "npm start" again.`,
      ),
      { error: "ServerOutOfDate", status: res.status },
    );
  }
  if (!res.ok) throw Object.assign(new Error(body.message ?? body.error ?? "Request failed"), body);
  return body as T;
}

export interface Api {
  state(): Promise<any>;
  job(id: string): Promise<any>;
  evidence(id: string): Promise<any>;
  create(scenarioId: string, approvedPackDigest?: string, revisionReason?: string): Promise<any>;
  act(id: string, action: string, body?: unknown): Promise<any>;
  runAgents(scenarioId: string): Promise<any>;
  blocked(id: string): Promise<any>;
  auto(scenarioId: string, approvedPackDigest?: string, revisionReason?: string): Promise<any>;
  autoForJob(jobId: string): Promise<any>;
  importBatch(rows: string, title: string): Promise<any>;
  pack(scenarioId: string): Promise<any>;
}

const serverApi: Api = {
  state: () => call("/api/state"),
  job: (id) => call(`/api/job/${id}`),
  evidence: (id) => call(`/api/job/${id}/evidence`),
  create: (scenarioId, approvedPackDigest, revisionReason) =>
    call("/api/job/create", { method: "POST", body: JSON.stringify({ scenarioId, approvedPackDigest, revisionReason }) }),
  act: (id, action, body = {}) => call(`/api/job/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }),
  runAgents: (scenarioId) => call("/api/agents/run", { method: "POST", body: JSON.stringify({ scenarioId }) }),
  blocked: (id) => call(`/api/blocked/${id}`, { method: "POST" }),
  auto: (scenarioId, approvedPackDigest, revisionReason) =>
    call("/api/job/auto", { method: "POST", body: JSON.stringify({ scenarioId, approvedPackDigest, revisionReason }) }),
  autoForJob: (jobId) => call(`/api/job/${jobId}/auto`, { method: "POST" }),
  importBatch: (rows, title) => call("/api/job/import", { method: "POST", body: JSON.stringify({ rows, title }) }),
  pack: (scenarioId) => call(`/api/pack/${scenarioId}`),
};

/** Lazily started so the 2 MB EVM is only fetched by the build that needs it. */
let enginePromise: Promise<any> | null = null;
async function engine() {
  if (!enginePromise) enginePromise = import("./engine.ts").then((m) => m.Engine.start());
  return enginePromise;
}

const staticApi: Api = {
  state: async () => (await engine()).state(),
  job: async (id) => (await engine()).jobDetail(id),
  evidence: async (id) => (await engine()).evidence(id),
  create: async (scenarioId, approvedPackDigest, revisionReason) => {
    const e = await engine();
    const job = await e.createJob(scenarioId, approvedPackDigest
      ? { revision: { approvedPackDigest, reason: revisionReason ?? "" } } : {});
    return e.jobDetail(job.jobId);
  },
  act: async (id, action, body: any = {}) => {
    const e = await engine();
    if (action === "accept") await e.accept(id);
    else if (action === "fund") await e.fund(id);
    else if (action === "submit") await e.submit(id);
    else if (action === "settle") await e.settle(id);
    else if (action === "refund") await e.refundExpired(id);
    else if (action === "advance-time") await e.advanceTime(Math.max(1, Math.min(86400, Number(body?.seconds ?? 60))));
    else throw new Error(`Unknown action ${action}`);
    return e.jobDetail(id);
  },
  runAgents: async () => {
    // A browser tab cannot spawn processes. Saying so beats pretending.
    throw Object.assign(new Error(
      "The two agent programs run as separate operating-system processes, which a browser tab cannot do. " +
      "Clone the repository and run npm start to see that demonstration."), { error: "NotInStaticBuild" });
  },
  blocked: async () => {
    throw Object.assign(new Error(
      "The blocked-action demonstrations are available in the local build. Clone the repository and run npm start."),
      { error: "NotInStaticBuild" });
  },
  auto: async (scenarioId, approvedPackDigest, revisionReason) => {
    const e = await engine();
    const log: string[] = [];
    const job = await e.runAutomatic(scenarioId, (l: string) => log.push(l), approvedPackDigest
      ? { revision: { approvedPackDigest, reason: revisionReason ?? "" } } : {});
    return { log, job: await e.jobDetail(job.jobId) };
  },
  autoForJob: async (jobId) => {
    const e = await engine();
    const log: string[] = [];
    await e.runAutomaticForJob(jobId, (l: string) => log.push(l));
    return { log, job: await e.jobDetail(jobId) };
  },
  importBatch: async (rows, title) => {
    const { importRecordsFromJson } = await import("../shared/importJson.ts");
    const parsed = importRecordsFromJson(rows);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const e = await engine();
    const job = await e.createJobFromRows(parsed.rows, title);
    return { ok: true, job: await e.jobDetail(job.jobId) };
  },
  pack: async (scenarioId) => {
    const e = await engine();
    const { coverage, packDigest } = await import("../shared/pack.ts");
    const preview = e.previewScopeRevision(scenarioId);
    return {
      pack: preview.original,
      coverage: coverage(preview.original),
      packDigest: packDigest(preview.original),
      revision: {
        needed: preview.needsRevision,
        revisedPack: preview.revised,
        revisedPackDigest: preview.revisedPackDigest,
        reason: preview.reason,
      },
    };
  },
};

export const api: Api = STATIC_BUILD ? staticApi : serverApi;

/** Integer formatting only. No floating point touches a money value anywhere in this app. */
export function formatUnits(baseUnits: string, decimals: number): string {
  const v = BigInt(baseUnits);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "−" : ""}${abs / scale}${frac ? `.${frac}` : ""}`;
}

export function formatCents(cents: string): string {
  const v = BigInt(cents);
  return `${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}

export const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "none");
