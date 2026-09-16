import { useCallback, useEffect, useState } from "react";
import { api, formatUnits, short, STATIC_BUILD } from "./api.ts";
import {
  Chip, Facts, Fault, Fold, Party, Readout, RunLog, Rows, Segment, StatusChip, TxList,
  type Tone,
} from "./components.tsx";
import { AgentField } from "./AgentField.tsx";
import { API_VERSION } from "../shared/apiVersion.ts";

const ROLE: Record<string, string> = {
  buyer: "Buyer agent", provider: "Provider agent", thirdParty: "Unrelated account",
  deployer: "Deployer", escrow: "Escrow",
};

type View = "overview" | "steps" | "evidence";

/**
 * A job's own movements, as the server derived them from that job's receipts. Never a subtraction
 * of wallet balances: a later or concurrent job would otherwise be attributed to this one.
 */
function jobDeltas(job: any): [string, bigint][] {
  return Object.entries((job?.balanceDeltas ?? {}) as Record<string, string>)
    .filter(([r]) => r !== "totalLocked" && r !== "escrow")
    .map(([r, v]) => [r, BigInt(v)] as [string, bigint]);
}

function useTheme() {
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(
    () => (localStorage.getItem("theme") as any) ?? "auto",
  );
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  const [state, setState] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [agentLog, setAgentLog] = useState<string[]>([]);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<any>(null);
  const [scopeBlock, setScopeBlock] = useState<any>(null);
  const [evidence, setEvidence] = useState<any>(null);
  const [theme, setTheme] = useTheme();
  const [importText, setImportText] = useState(
    JSON.stringify(
      [{ productId: 7003, priceCents: 2599 }, { productId: 7001, priceCents: 999 }, { productId: 7002, priceCents: 14500 }],
      null, 2,
    ),
  );
  const [importIssues, setImportIssues] = useState<any[]>([]);

  const [staleServer, setStaleServer] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state();
      // A page newer than the process serving it is the single most confusing failure here,
      // because it only shows up when a button is pressed. Detect it on load instead.
      setStaleServer(next.apiVersion === API_VERSION ? null : (next.apiVersion ?? "older than this check"));
      setState(next);
    } catch (e: any) { setError(e.message); }
  }, []);
  const refreshJob = useCallback(async (id: string) => {
    try { setJob(await api.job(id)); } catch (e: any) { setError(e.message); }
  }, []);

  // The interface always redraws from the chain's actual state, so a refresh or a restart never
  // shows a stale outcome and never repeats a financial action.
  useEffect(() => { refreshState(); }, [refreshState]);
  useEffect(() => {
    const t = setInterval(() => { refreshState(); if (selected) refreshJob(selected); }, 2500);
    return () => clearInterval(t);
  }, [refreshState, refreshJob, selected]);

  // An exported bundle belongs to one job. Selecting another must drop it, or the panel can show
  // one job's header above another job's evidence.
  useEffect(() => { setEvidence(null); }, [selected]);

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key); setError(null);
    try { return await fn(); }
    catch (e: any) { setError(`${e.error ?? "Rejected"}: ${e.message}`); throw e; }
    finally { setBusy(null); await refreshState(); }
  };

  const show = (j: any, v: View = "overview") => { setSelected(j.jobId); setJob(j); setView(v); };
  const clearPanels = () => { setBlocked(null); setEvidence(null); setScopeBlock(null); };

  const runAutomatic = async (scenarioId: string) => {
    setAutoLog([]); setAgentLog([]); clearPanels();
    const res = await run(`auto:${scenarioId}`, () => api.auto(scenarioId));
    setAutoLog(res.log); show(res.job);
  };

  const importBatch = async () => {
    setImportIssues([]); setAutoLog([]); clearPanels();
    const res = await run("import", () => api.importBatch(importText, "Imported batch"));
    if (!res.ok) { setImportIssues(res.issues); return; }
    show(res.job);
    const done = await run("auto:imported", () => api.autoForJob(res.job.jobId));
    setAutoLog(done.log); show(done.job);
  };

  const startScenario = async (scenarioId: string, approval?: { digest: string; reason: string }) => {
    setAgentLog([]); setAutoLog([]); clearPanels();
    try {
      show(await run(`create:${scenarioId}`, () => api.create(scenarioId, approval?.digest, approval?.reason)));
    } catch (e: any) {
      // Refused because the agreement still contains a clause software cannot check. Nothing was
      // created and no funds moved. Show the clause and the exact revised pack being approved.
      if (e.error === "ScopeRevisionRequired" || e.error === "UnsupportedClausesPresent") {
        setError(null);
        setScopeBlock({ scenarioId, ...(await api.pack(scenarioId)) });
      }
    }
  };

  const runAgents = async (scenarioId: string) => {
    setAgentLog(["starting the buyer and provider programs as separate processes…"]);
    setAutoLog([]); clearPanels();
    const res = await run(`agents:${scenarioId}`, () => api.runAgents(scenarioId));
    setAgentLog(res.log);
    if (res.job?.jobId && !String(res.job.jobId).startsWith("blocked-")) show(res.job, "steps");
    else { setSelected(null); setJob(null); }
  };

  const act = async (action: string, body?: unknown) => {
    if (!selected) return;
    setJob(await run(`act:${action}`, () => api.act(selected, action, body)));
  };

  const loadEvidence = async () => {
    if (!job) return;
    setEvidence(await run("evidence", () => api.evidence(job.jobId)));
  };

  // In the static build the first call also downloads and starts an EVM in this tab. Say so
  // rather than showing a half-empty page while ~2 MB arrives.
  const booting = STATIC_BUILD && !state;
  const scenarios = state?.scenarios ?? [];
  const status = job?.onChain?.status ?? "—";
  const decimals = state?.token?.decimals ?? 6;
  const symbol = state?.token?.symbol ?? "mUSD";
  const running = !!busy?.startsWith("auto");

  return (
    <div className="shell">
      {/* Mandatory disclosure. One precise line, always present. ----------- */}
      <div className="statusbar" role="status">
        <div className="bay">
          <div className="readout">
            <span className="beacon" aria-hidden="true" />
            <b>Local simulation</b>
            <span className="bar" aria-hidden="true" />
            <span>synthetic data</span>
            <span className="bar" aria-hidden="true" />
            <span>test funds with no value</span>
            <span className="bar" aria-hidden="true" />
            <span>one operator controls every participant</span>
            <span className="bar" aria-hidden="true" />
            <span>buyer and provider agents are deterministic programs, not language models</span>
            <span className="bar" aria-hidden="true" />
            <span>{STATIC_BUILD ? "chain runs in this tab" : "chain runs on your machine"}</span>
          </div>
          <div className="themes" role="group" aria-label="Appearance">
            {(["auto", "light", "dark"] as const).map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      {staleServer && (
        <div className="bay" style={{ paddingTop: "var(--s5)" }}>
          <div className="fault" role="alert">
            <b>The running server is older than this page.</b>{" "}
            Vite reloaded the browser from disk, but the Node process was started before these
            routes existed, so actions will fail with a parse error when you press them. Stop it
            (Ctrl+C) and run <code>npm start</code> again.
            <div className="note" style={{ marginTop: 6 }}>
              page {API_VERSION} · server {staleServer}
            </div>
          </div>
        </div>
      )}

      {/* Hero -------------------------------------------------------------- */}
      <header className="bay hero">
        <AgentField seed={state?.chain?.contractSourcesHash} />
        <span className="tag">Acceptance infrastructure · local demonstration</span>
        <h1 className="display">Agree on what counts as done.</h1>
        <p className="lede">
          Agents are starting to buy work from one another — a job goes out, a result comes back,
          and payment settles with no human reading either one. So who decides the work was
          acceptable? Not the buyer, who would rather not pay. Not the provider, who would rather be
          paid. Neither can judge its own case.
        </p>
        <p className="lede second">
          So they settle it first. Both sides approve a checklist of what finished work looks
          like, written so software can check it. The payment goes into escrow, the work is
          delivered, and a contract runs exactly those checks against exactly what arrived — then
          pays or refunds. Nobody, including whoever deployed the contract, can overrule the answer.
        </p>
        <div className="cta">
          <button className="beam lg" onClick={() => runAutomatic("pass")} disabled={!!busy || booting}>
            {busy === "auto:pass" && <span className="spin" />}
            Run a job that satisfies the checklist
          </button>
          <button className="lg" onClick={() => runAutomatic("fail-order")} disabled={!!busy || booting}>
            {busy === "auto:fail-order" && <span className="spin" />}
            Run one that does not
          </button>
        </div>
        {booting && (
          <p className="note" style={{ marginTop: "var(--s4)", textAlign: "center" }}>
            <span className="spin" style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 9 }} />
            Starting an Ethereum virtual machine in this tab and deploying the contracts. About 2 MB,
            fetched once.
          </p>
        )}
      </header>

      {/* Launch bays ------------------------------------------------------- */}
      <section className="bay" style={{ paddingBottom: "var(--s8)" }}>
        <div className="grid">
          <div className="col-6">
            <div className="panel lit lifted" style={{ height: "100%" }}>
              <div className="panel-head">
                <div>
                  <span className="tag">Sequence</span>
                  <h2 className="heading" style={{ marginTop: 6 }}>Run an automatic job</h2>
                </div>
                {running && <span className="spin" />}
              </div>
              <div className="pad stack">
                <p className="body-2">
                  One click runs the whole thing: the buyer agent proposes an agreement, the provider
                  agent re-derives it from the contract and accepts, the buyer funds the escrow, and
                  the provider delivers. Checking and payment happen in the same transaction. The step
                  list appears when the run finishes — it is a log, not a live feed.
                </p>
                {running
                  ? <p className="note"><span className="spin" style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 9 }} />Running…</p>
                  : <RunLog lines={autoLog} />}
              </div>
            </div>
          </div>

          <div className="col-6">
            <div className="panel" style={{ height: "100%" }}>
              <div className="panel-head">
                <div>
                  <span className="tag">Reuse</span>
                  <h2 className="heading" style={{ marginTop: 6 }}>Use your own batch</h2>
                </div>
              </div>
              <div className="pad stack">
                <p className="body-2">
                  Paste a few rows and the same fixed template is rebound to them: same four rules,
                  new source, new agreement. Only this one template is supported — this is not a
                  general-purpose acceptance editor.
                </p>
                <textarea
                  className="rows" value={importText} spellCheck={false}
                  onChange={(e) => setImportText(e.target.value)}
                  aria-label="Rows to import as JSON"
                />
                <div className="row">
                  <button onClick={importBatch} disabled={!!busy || booting}>
                    {(busy === "import" || busy === "auto:imported") && <span className="spin" />}
                    Import and run it automatically
                  </button>
                </div>
                {importIssues.length > 0 && (
                  <div className="fault" role="alert">
                    {importIssues.map((i, n) => (
                      <div key={n}><b>{i.code}</b>{i.rowIndex !== undefined ? ` (row ${i.rowIndex})` : ""}: {i.message}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Workspace --------------------------------------------------------- */}
      <main className="bay" style={{ paddingBottom: "var(--s10)" }}>
        <div className="section-head">
          <span className="tag">Workspace</span>
          <span className="rule" />
        </div>

        <div className="grid">
          <aside className="col-3 stack">
            <section className="panel">
              <div className="panel-head">
                <h2 className="heading">Jobs</h2>
                <span className="tag">{(state?.jobs ?? []).length}</span>
              </div>
              <div className="manifest">
                {(state?.jobs ?? []).length === 0 && (
                  <p className="note" style={{ padding: "var(--s4) var(--s6)" }}>None yet.</p>
                )}
                {(state?.jobs ?? []).map((j: any) => (
                  <button key={j.jobId} aria-current={selected === j.jobId}
                    onClick={() => { setSelected(j.jobId); setView("overview"); refreshJob(j.jobId); }}
                    disabled={String(j.jobId).startsWith("blocked-")}>
                    <span><span className="id">#{j.jobId}</span><span className="of">{j.scenarioId}</span></span>
                    <StatusChip status={j.status} />
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2 className="heading">Current wallet totals</h2>
                <span className="tag">{symbol}</span>
              </div>
              <div className="pad-s stack">
                <div className="readouts pair">
                  <Readout k="Buyer" v={formatUnits(state?.balances?.buyer ?? "0", decimals)} />
                  <Readout k="Provider" v={formatUnits(state?.balances?.provider ?? "0", decimals)} />
                  <Readout k="Escrow" v={formatUnits(state?.balances?.escrow ?? "0", decimals)} />
                </div>
                <p className="note">
                  Totals across every job in this session. What a single job moved is shown on that
                  job, derived from its own receipts.
                  {state?.topUps > 0 && (
                    <> The buyer's test wallet has been refilled {state.topUps}{" "}
                    {state.topUps === 1 ? "time" : "times"} so the demonstration could continue — mUSD is a
                    valueless mock with an open faucet, so this is not income and is not part of any job's
                    accounting.</>
                  )}
                </p>
                <Fold label="Chain and contracts">
                  <Facts items={[
                    ["Chain", String(state?.chain?.chainId ?? "")],
                    ["Network", state?.chain?.label ?? ""],
                    ["Escrow", <span className="mono">{state?.chain?.addresses?.escrow}</span>],
                    ["Policy", <span className="mono">{state?.chain?.addresses?.policy}</span>],
                    ["Token", <span className="mono">{state?.chain?.addresses?.token}</span>],
                    ["Compiler", state?.chain?.solcVersion ?? ""],
                    ["Sources", <span className="mono">{short(state?.chain?.contractSourcesHash)}</span>],
                    ["Skew", `${state?.chain?.timeSkewSeconds ?? 0}s`],
                  ]} />
                </Fold>
              </div>
            </section>

          </aside>

          <div className="col-9 stack">
            <Fault message={error} onDismiss={() => setError(null)} />

            {scopeBlock && (
              <ScopeBlock block={scopeBlock} busy={!!busy}
                onRevise={() => startScenario(scopeBlock.scenarioId, {
                  digest: scopeBlock.revision.revisedPackDigest,
                  reason: scopeBlock.revision.reason,
                })} />
            )}

            {!job && !scopeBlock && (
              <div className="voidstate">
                <span className="tag">Nothing selected</span>
                <h2 className="title">Run a job above to see it here</h2>
                <p className="note">
                  Every job carries its own agreement, its own escrow and its own record — nothing is
                  shared between them, and one job never reaches two different outcomes.
                </p>
              </div>
            )}

            {job && (
              <section className="panel lifted lift">
                <div className="panel-head">
                  <div>
                    <span className="tag">Job #{job.jobId}</span>
                    <h2 className="title" style={{ marginTop: 6 }}>{job.pack?.title}</h2>
                  </div>
                  <div className="row">
                    <StatusChip status={status} />
                    <Segment label="Job detail" value={view} onChange={setView}
                      options={[
                        { id: "overview", label: "Overview" },
                        { id: "steps", label: "Steps" },
                        { id: "evidence", label: "Evidence" },
                      ]} />
                  </div>
                </div>

                {view === "overview" && (
                  <div className="pad stack" style={{ gap: "var(--s6)" }}>
                    <Overview job={job} status={status} decimals={decimals} symbol={symbol} />
                    <div className="row">
                      <button onClick={() => setView("steps")}>Inspect each step</button>
                      <button className="ghost" onClick={() => { setView("evidence"); loadEvidence(); }}>
                        Export and verify an evidence bundle
                      </button>
                    </div>
                  </div>
                )}

                {view === "steps" && (
                  <div className="pad">
                    <div className="sequence">
                      <PhaseJob job={job} decimals={decimals} symbol={symbol} />
                      <PhaseAgreement job={job} act={act} busy={busy} status={status} />
                      <PhaseDelivery job={job} act={act} busy={busy} status={status} />
                      <PhaseChecks job={job} status={status} />
                      <PhasePayment job={job} status={status} act={act} busy={busy} decimals={decimals} symbol={symbol} />
                    </div>
                  </div>
                )}

                {view === "evidence" && (
                  <div className="pad stack">
                    {!evidence && (
                      <div className="row">
                        <button className="beam" onClick={loadEvidence} disabled={!!busy}>
                          {busy === "evidence" && <span className="spin" />}
                          Export and verify an evidence bundle
                        </button>
                      </div>
                    )}
                    {evidence?.bundle?.job?.jobId === job.jobId && <EvidencePanel evidence={evidence} />}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>

        <div style={{ marginTop: "var(--s6)" }}>
            <details className="bay-panel">
              <summary><span className="caret" aria-hidden="true" /><span className="heading">Advanced demonstration</span></summary>
              <div className="inner">
                <p className="note" style={{ maxWidth: "70ch" }}>
                  Individual fixtures, the two agent processes, and unauthorized actions really sent
                  to the contract. Useful for scrutiny; not the main story.
                </p>

                <div className="grid">
                <div className="col-4 stack-s">
                  <span className="tag">Other fixtures</span>
                  {scenarios.map((sc: any) => (
                    <button key={sc.id} className="bare"
                      style={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", padding: "10px 12px" }}
                      onClick={() => startScenario(sc.id)} disabled={!!busy}>
                      <span>
                        <span style={{ fontWeight: 590, color: "var(--ink)" }}>{sc.label}</span>
                        <span className="note" style={{ display: "block", marginTop: 3 }}>{sc.short}</span>
                      </span>
                    </button>
                  ))}
                  <p className="note">Each button creates its own separate job. One job never reaches two different outcomes.</p>
                </div>

                {!STATIC_BUILD && <div className="col-4 stack-s">
                  <span className="tag">Run the two demo programs</span>
                  <p className="note">
                    Starts the buyer and provider as real separate operating-system processes with
                    separate keys, talking only through the chain. Both are started by this server,
                    and both are controlled by the same operator.
                  </p>
                  <div className="row">
                    {["pass", "fail-order", "expiry", "unsupported-scope"].map((id) => (
                      <button key={id} className="sm" onClick={() => runAgents(id)} disabled={!!busy}>
                        {busy === `agents:${id}` && <span className="spin" />}{id}
                      </button>
                    ))}
                  </div>
                  {agentLog.length > 0 && <pre className="log">{agentLog.join("\n")}</pre>}
                </div>}

                {!STATIC_BUILD && <div className="col-4 stack-s">
                  <span className="tag">Attempt a blocked action</span>
                  <p className="note">Each of these really sends the transaction and records what the contract does with it.</p>
                  <div className="blocked-list">
                    {(state?.blockedActions ?? []).map((a: any) => (
                      <button key={a.id} className="sm wrap" disabled={!!busy}
                        onClick={async () => { setBlocked(await run(`blocked:${a.id}`, () => api.blocked(a.id))); }}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  {blocked && (
                    <div className="clause lift">
                      <div className="between">
                        <b>{blocked.label}</b>
                        <Chip tone={blocked.outcome === "REJECTED" ? "go" : "no"}>
                          {blocked.outcome === "REJECTED" ? "blocked" : "ALLOWED — investigate"}
                        </Chip>
                      </div>
                      <div className="n">Attempted: {blocked.attempted}</div>
                      <div className="n">
                        Contract responded <code>{blocked.error.name}
                        {blocked.error.args.length ? `(${blocked.error.args.join(", ")})` : ""}</code>
                      </div>
                      <div className="n">
                        Job status stayed <b>{blocked.statusAfter}</b>; balances unchanged: <b>{String(blocked.balancesUnchanged)}</b>
                      </div>
                      <div className="n">{blocked.explanation}</div>
                    </div>
                  )}
                </div>}

                {STATIC_BUILD && (
                  <div className="col-8 stack-s">
                    <span className="tag">Only in the local build</span>
                    <p className="note">
                      Two demonstrations are missing here, and are missing rather than simulated.
                      Running the buyer and provider as <b>separate operating-system processes with
                      separate keys</b> is something a browser tab cannot do, and showing the same
                      code in-page under that label would claim something untrue. The same goes for
                      the ten <b>unauthorized actions</b>, which are worth watching against a chain
                      you started yourself.
                    </p>
                    <p className="note">
                      Both are in the repository. Clone it and run <code>npm start</code> — along
                      with 201 automated tests, the headless-browser checks, and the offline
                      evidence verifier.
                    </p>
                  </div>
                )}
                </div>
              </div>
            </details>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ job, status, decimals, symbol }: any) {
  const preview = job.localPreview;
  const t = job.onChain?.terms;
  const deltas = jobDeltas(job);

  const tone: Tone = status === "PAID" ? "go" : status === "REJECTED" ? "no" : status === "EXPIRED" ? "hold" : "idle";
  const sigil = status === "PAID" ? "✓" : status === "REJECTED" ? "✕" : status === "EXPIRED" ? "◷" : "◌";
  const line =
    status === "PAID" ? "The delivery met every agreed rule, so the contract paid the provider."
    : status === "REJECTED" ? "The delivery did not meet the agreed rules, so the contract refunded the buyer."
    : status === "EXPIRED" ? "Nothing was settled before the deadline, so the escrow returned to the buyer."
    : "This job is still in progress.";

  return (
    <>
      <div className={`verdict ${tone}`}>
        <div className="sigil" aria-hidden="true">{sigil}</div>
        <div style={{ minWidth: 0 }}>
          <div className="line-1">{line}</div>
          {preview && <div className="line-2">{preview.headline}</div>}
          {status === "EXPIRED" && (
            <div className="line-2">Refund after expiry is a timeout rule. It is not a finding that the work was bad.</div>
          )}
        </div>
      </div>

      <Facts items={[
        ["Buyer", <Party role="Buyer agent" address={t?.buyer} />],
        ["Provider", <Party role="Provider agent" address={t?.provider} />],
        ["Agreement", `${job.coverage?.executable} of ${job.pack?.clauses?.length} clauses executable, pack v${job.pack?.packVersion}`],
        ["Payment", `${formatUnits(t?.amount ?? "0", decimals)} ${symbol} (test tokens, no value)`],
      ]} />

      {deltas.some(([, d]) => d !== 0n) && (
        <div className="readouts">
          {deltas.filter(([, d]) => d !== 0n).map(([k, d]) => (
            <Readout key={k} k={`${ROLE[k] ?? k} · this job`}
              v={`${d > 0n ? "+" : "−"}${formatUnits((d < 0n ? -d : d).toString(), decimals)}`}
              unit={symbol} tone={d > 0n ? "up" : "down"} />
          ))}
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- scope block */

function ScopeBlock({ block, onRevise, busy }: { block: any; onRevise: () => void; busy: boolean }) {
  const unsupported = block.pack.clauses.filter((c: any) => c.coverage !== "EXECUTABLE");
  return (
    <section className="panel lifted lift">
      <div className="panel-head">
        <h2 className="title">This job cannot be created</h2>
        <Chip tone="hold">blocked</Chip>
      </div>
      <div className="pad stack">
        <p className="body-2">
          The contract refused the job. The acceptance pack still contains a clause that software
          cannot check, and this product does not pretend otherwise.
        </p>
        {unsupported.map((c: any) => (
          <div className="clause" key={c.id}>
            <div className="between">
              <span className="t"><b>{c.id}.</b> {c.text}</span>
              <Chip tone="hold">{c.coverage.replace(/_/g, " ").toLowerCase()}</Chip>
            </div>
            <div className="n">{c.note}</div>
          </div>
        ))}
        <p className="advisory">
          There is no button that quietly deletes the clause, and no automatic path that revises it
          for you. The only way forward is an explicit scope revision, which produces a new pack
          version where the clause is still listed, marked as excluded, with the reason attached — so
          both parties can see exactly what payment no longer depends on.
        </p>
        {block.revision?.needed && (
          <Facts items={[
            ["You would be approving", `pack version ${block.revision.revisedPack.packVersion}`],
            ["Digest", <span className="mono">{block.revision.revisedPackDigest}</span>],
            ["Reason", block.revision.reason],
          ]} />
        )}
        <div className="row">
          <button className="beam" onClick={onRevise} disabled={busy}>
            Approve that revised pack and create the job
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- phases */

function Phase({ n, title, why, done, live, waiting, children }: any) {
  return (
    <div className={`phase ${done ? "done" : ""} ${live ? "live" : ""} ${waiting ? "waiting" : ""}`}>
      <div className="spine">
        <span className="mark">{done ? "✓" : n}</span>
        <span className="thread" />
      </div>
      <div className="what">
        <div>
          <h3 className="heading">{title}</h3>
          {why && <p className="why">{why}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function PhaseJob({ job, decimals, symbol }: any) {
  const t = job.onChain?.terms;
  return (
    <Phase n={1} title="The job" done why="Who is involved, what is being asked for, and what is being offered for it.">
      <Facts items={[
        ["Buyer", <Party role="Buyer agent (operator-controlled)" address={t?.buyer} />],
        ["Provider", <Party role="Provider agent (operator-controlled)" address={t?.provider} />],
        ["Task", "Normalise a product catalogue: return every product once, keep its price, sort by product ID."],
        ["Offered", `${formatUnits(t?.amount ?? "0", decimals)} ${symbol} (test tokens, no value)`],
      ]} />
      <Fold label={`Approved source — ${job.source?.length ?? 0} rows, supplied in shuffled order`}>
        <Rows rows={job.onChain?.source ?? []} />
      </Fold>
    </Phase>
  );
}

function PhaseAgreement({ job, act, busy, status }: any) {
  const cov = job.coverage;
  const accepted = ["ACCEPTED", "FUNDED", "SUBMITTED", "PAID", "REJECTED", "EXPIRED"].includes(status);
  const funded = ["FUNDED", "SUBMITTED", "PAID", "REJECTED", "EXPIRED"].includes(status);
  return (
    <Phase n={2} title="The agreement" done={funded} live={!funded}
      why="The checklist both sides approve before work begins. These rules, and only these, govern the payment.">
      <div className="between">
        <span className="body-2" style={{ color: "var(--ink)" }}>
          <b>{cov?.executable} of {job.pack?.clauses?.length} clauses are executable</b>
          {cov?.excludedByRevision ? ` · ${cov.excludedByRevision} excluded by explicit revision` : ""}
        </span>
        <Chip tone={cov?.fullyAutomatic ? "go" : "hold"}>
          {cov?.fullyAutomatic ? "fully checkable" : "not fully checkable"}
        </Chip>
      </div>

      <div>
        {job.pack?.clauses?.map((c: any) => (
          <div className="clause" key={c.id}>
            <div className="between">
              <span className="t"><b>{c.id}.</b> {c.text}</span>
              <Chip tone={c.coverage === "EXECUTABLE" ? "go" : c.coverage === "EXCLUDED_BY_REVISION" ? "idle" : "hold"}>
                {c.coverage === "EXECUTABLE" ? `rule ${c.ruleId}` : c.coverage.replace(/_/g, " ").toLowerCase()}
              </Chip>
            </div>
            <div className="n">{c.note}</div>
          </div>
        ))}
      </div>

      {job.pack?.revisionHistory?.length > 0 && (
        <div className="clause">
          <b>Revision history</b>
          {job.pack.revisionHistory.map((r: string, i: number) => <div className="n" key={i}>{r}</div>)}
        </div>
      )}

      <p className="note">The buyer approved these terms by creating the job. Provider approval is a separate action:</p>
      <div className="row">
        <button onClick={() => act("accept")} disabled={!!busy || status !== "CREATED"}>
          {accepted ? "✓ Provider accepted" : "Provider: verify and accept these exact terms"}
        </button>
        <button onClick={() => act("fund")} disabled={!!busy || status !== "ACCEPTED"}>
          {funded ? "✓ Buyer funded the escrow" : "Buyer: lock the payment in escrow"}
        </button>
      </div>
      <p className="note">
        Before accepting, the provider re-derives the whole agreement from what the contract actually
        stored — amount, source batch, token address, deadlines, every clause — and refuses on any
        disagreement.
      </p>

      <Fold label="Terms, version and commitments">
        <Facts items={[
          ["Pack", `v${job.pack?.packVersion} of ${job.pack?.templateId}/v${job.pack?.templateVersion}`],
          ["Checker", `${job.pack?.checkerPolicyIdPreimage} v${job.pack?.checkerPolicyVersion}`],
          ["Terms", <span className="mono">{job.onChain?.termsDigest}</span>],
          ["Source", <span className="mono">{job.onChain?.terms?.sourceDigest}</span>],
          ["Pack hash", <span className="mono">{job.onChain?.terms?.packDigest}</span>],
          ["Deliver by", new Date((job.onChain?.terms?.deliveryDeadline ?? 0) * 1000).toISOString()],
          ["Expires", new Date((job.onChain?.terms?.settlementExpiry ?? 0) * 1000).toISOString()],
        ]} />
      </Fold>
    </Phase>
  );
}

function PhaseDelivery({ job, act, busy, status }: any) {
  const submitted = job.onChain?.output?.length > 0;
  const canSubmit = status === "FUNDED";
  return (
    <Phase n={3} title="The delivery" done={submitted} live={canSubmit}
      waiting={!["FUNDED", "SUBMITTED", "PAID", "REJECTED", "EXPIRED"].includes(status)}
      why="What the provider actually submitted, and the fingerprint the contract computed from it.">
      {canSubmit && (
        <div className="row">
          <button className="beam" onClick={() => act("submit")} disabled={!!busy}>Provider: submit the result</button>
        </div>
      )}
      {!submitted && !canSubmit && <p className="note">Nothing submitted yet.</p>}
      {submitted && (
        <>
          <Rows rows={job.onChain.output} hit={job.localPreview?.result?.detailA ? [String(job.localPreview.result.detailA)] : []} />
          <Facts items={[["Fingerprint", <span className="mono">{job.onChain.deliveryDigest}</span>]]} />
          <p className="note">
            This fingerprint covers the canonical typed rows the contract stored, not the formatting of
            any file. The settlement function reads those stored rows; no caller can hand it different ones.
          </p>
        </>
      )}
    </Phase>
  );
}

function PhaseChecks({ job, status }: any) {
  const preview = job.localPreview;
  const settled = ["PAID", "REJECTED"].includes(status);
  const recorded = job.onChain;
  return (
    <Phase n={4} title="The checks" done={settled} waiting={!preview}
      why="The agreed rules run against this exact delivery for this exact job.">
      {!preview && <p className="note">No delivery to check yet.</p>}
      {preview && (
        <>
          <div className="between">
            <b className="body-2" style={{ color: "var(--ink)" }}>{preview.headline}</b>
            <Chip tone={preview.result.verdictName === "PASS" ? "go" : preview.result.verdictName === "FAIL" ? "no" : "hold"}>
              {preview.result.verdictName}
            </Chip>
          </div>
          <div>
            {preview.findings.map((f: any) => (
              <div className="check-line" key={f.ruleId}>
                <span className={`glyph ${f.status === "PASS" ? "ok" : f.status === "FAIL" ? "bad" : "off"}`} aria-hidden="true">
                  {f.status === "PASS" ? "✓" : f.status === "FAIL" ? "✕" : "·"}
                </span>
                <div>
                  <div>{f.plain}</div>
                  <div className="sub">{f.detail}</div>
                </div>
                <span className="tag">Rule {f.ruleId}</span>
              </div>
            ))}
          </div>
          {settled ? (
            <p className="note">
              The contract recorded verdict <b>{["indeterminate", "pass", "fail"][recorded.verdict]}</b>
              {recorded.ruleId ? ` on rule ${recorded.ruleId} (code ${recorded.failCode})` : ""}. The findings
              above are the same rules computed here for display; the money moved on the contract's own
              evaluation, not on this one.
            </p>
          ) : (
            <p className="note">
              This is a preview computed in the browser process. It has no authority. The contract runs
              the identical rules itself when settlement is requested.
            </p>
          )}
        </>
      )}
    </Phase>
  );
}

function PhasePayment({ job, status, act, busy, decimals, symbol }: any) {
  const terminal = ["PAID", "REJECTED", "EXPIRED"].includes(status);
  const pastExpiry = (job?.now ?? 0) >= (job.onChain?.terms?.settlementExpiry ?? 0);
  const deltas = jobDeltas(job);
  return (
    <Phase n={5} title="The payment" done={terminal}
      waiting={!["SUBMITTED", "FUNDED", "PAID", "REJECTED", "EXPIRED"].includes(status)}
      why="What actually happened to the money, read back from the chain.">
      <div className="between">
        <span className="body-2" style={{ color: "var(--ink)" }}>
          {status === "PAID" && "Released to the provider agent."}
          {status === "REJECTED" && "Refunded to the buyer: the delivery did not meet the agreed rules."}
          {status === "EXPIRED" && "Refunded to the buyer on timeout."}
          {status === "SUBMITTED" && "Held in escrow, awaiting a settlement request."}
          {status === "FUNDED" && "Held in escrow, awaiting delivery."}
          {["CREATED", "ACCEPTED"].includes(status) && "Nothing is locked yet."}
        </span>
        <StatusChip status={status} />
      </div>

      {status === "EXPIRED" && (
        <p className="advisory">
          Refund after expiry is a timeout rule. It is not a finding that the work was bad, and it can
          strike a conforming delivery whose settlement was never requested in time.
        </p>
      )}

      <div className="row">
        <button className="beam" onClick={() => act("settle")} disabled={!!busy || status !== "SUBMITTED" || pastExpiry}>
          Request settlement (anyone may)
        </button>
        <button onClick={() => act("advance-time", { seconds: 120 })} disabled={!!busy || terminal}>
          Advance local chain time 2 minutes
        </button>
        <button onClick={() => act("refund")} disabled={!!busy || !["FUNDED", "SUBMITTED"].includes(status) || !pastExpiry}>
          Refund after expiry
        </button>
      </div>
      {status === "SUBMITTED" && pastExpiry && (
        <p className="advisory">Settlement is now closed for this job. Only the refund path remains.</p>
      )}

      {deltas.some(([, d]) => d !== 0n) && (
        <div className="readouts">
          {deltas.filter(([, d]) => d !== 0n).map(([k, d]) => (
            <Readout key={k} k={ROLE[k] ?? k}
              v={`${d > 0n ? "+" : "−"}${formatUnits((d < 0n ? -d : d).toString(), decimals)}`}
              unit={symbol} tone={d > 0n ? "up" : "down"} />
          ))}
        </div>
      )}

      <Fold label={`Transactions (${job.transactions?.length ?? 0})`}>
        <TxList transactions={job.transactions ?? []} />
      </Fold>
    </Phase>
  );
}

/* ----------------------------------------------------------------- evidence */

function EvidencePanel({ evidence }: { evidence: any }) {
  const toneFor = (v: string): Tone => (v === "PASS" ? "go" : v === "FAIL" ? "no" : "hold");
  return (
    <div className="stack lift">
      <div className="row">
        {evidence.verification.sections.map((sec: any) => (
          <Chip key={sec.key} tone={toneFor(sec.verdict)}>
            {sec.title}: {sec.verdict.replace("_", " ").toLowerCase()}
          </Chip>
        ))}
      </div>

      {evidence.verification.sections.map((sec: any) => (
        <div key={sec.key} className="clause">
          <div className="between" style={{ marginBottom: sec.lines.length ? 12 : 0 }}>
            <b className="heading">{sec.title}</b>
            <Chip tone={toneFor(sec.verdict)}>{sec.verdict.replace("_", " ").toLowerCase()}</Chip>
          </div>
          {sec.lines.map((l: any) => (
            <div className="check-line" key={l.name}>
              <span className={`glyph ${l.ok ? "ok" : "bad"}`} aria-hidden="true">{l.ok ? "✓" : "✕"}</span>
              <div>
                <div>{l.name}</div>
                <div className="sub mono">{l.detail}</div>
              </div>
              <span />
            </div>
          ))}
          {sec.verdict === "NOT_CHECKED" && (
            <div className="n">
              Not checked here. The browser has no chain access; run{" "}
              <code>npm run verify -- &lt;bundle&gt; --rpc &lt;url&gt;</code> to establish that a payment
              actually happened.
            </div>
          )}
        </div>
      ))}

      <div className="clause">
        <b className="heading">Not established by this replay</b>
        {evidence.verification.notVerified.map((n: string, i: number) => <div className="n" key={i}>· {n}</div>)}
      </div>

      <div className="row">
        <a download={`job-${evidence.bundle.job.jobId}.json`}
          href={URL.createObjectURL(new Blob([JSON.stringify(evidence.bundle, null, 2)], { type: "application/json" }))}>
          <button className="sm">Download the bundle</button>
        </a>
      </div>
    </div>
  );
}
