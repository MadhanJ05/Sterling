#!/usr/bin/env node
/**
 * Browser smoke check and screenshot capture.
 *
 * Drives a real headless Chrome over the DevTools protocol using Node's built-in WebSocket, so it
 * adds no dependency to the project. It starts its own server on a spare port and shuts it down
 * afterwards, so it never disturbs a session you are demonstrating.
 *
 * Usage: npm run smoke
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";

const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = join(PROJECT_ROOT, "evidence", "screenshots");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? green("  ✓") : red("  ✗")} ${name}${detail ? dim(` — ${detail}`) : ""}`);
}

// ------------------------------------------------------------------ CDP client
class CDP {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  sessionId?: string;

  static async connect(url: string): Promise<CDP> {
    const c = new CDP();
    c.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      c.ws.addEventListener("open", () => res(), { once: true });
      c.ws.addEventListener("error", (e) => rej(new Error(`CDP socket error: ${String(e)}`)), { once: true });
    });
    c.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
      else p.resolve(msg.result);
    });
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId = this.sessionId): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout on ${method}`));
      }, 30_000);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result.value as T;
  }

  close() { this.ws.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

// ------------------------------------------------------------------- page ops
const JS = {
  bodyText: `document.body.innerText`,
  clickByText: (text: string, within?: string) => `(() => {
    const wanted = ${JSON.stringify(text)};
    const scope = ${JSON.stringify(within ?? null)};
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return false;
    const nodes = [...root.querySelectorAll('button, summary, a')];
    const norm = (s) => s.replace(/\\s+/g,' ').toLowerCase();
    const el = nodes.find(n => n.innerText && norm(n.innerText).includes(norm(wanted)) && !n.disabled);
    if (!el) return false;
    el.click();
    return true;
  })()`,
};

async function run() {
  mkdirSync(SHOTS, { recursive: true });
  const userDataDir = join(tmpdir(), `acceptance-smoke-${Date.now()}`);

  console.log(dim(`starting server on ${BASE}…`));
  const server: ChildProcess = spawn(
    process.execPath,
    [join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(PROJECT_ROOT, "src/server/index.ts")],
    { cwd: PROJECT_ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {});

  let chrome: ChildProcess | null = null;
  let cdp: CDP | null = null;

  try {
    await waitFor("server", async () => (await fetch(`${BASE}/api/state`)).ok, 90_000);
    console.log(dim("server up; launching headless Chrome…"));

    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1440,1400",
      "about:blank",
    ], { stdio: "ignore" });

    const version = await waitFor("chrome devtools", async () => {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return r.ok ? r.json() : null;
    }, 30_000);

    cdp = await CDP.connect((version as any).webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, undefined);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined);
    cdp.sessionId = sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1400, deviceScaleFactor: 2, mobile: false,
    });

    const shot = async (name: string) => {
      // Entrance animations are ~520ms. Capturing sooner photographs a half-faded interface.
      await sleep(620);
      const { data } = await cdp!.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      const path = join(SHOTS, `${name}.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      console.log(dim(`     screenshot -> evidence/screenshots/${name}.png`));
    };
    // innerText reflects CSS text-transform, so panel headings arrive uppercased. All text
    // matching here is therefore case-insensitive and whitespace-normalised.
    const text = async () => (await cdp!.evaluate<string>(JS.bodyText)).replace(/\s+/g, " ");
    const has = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());
    const clickText = async (t: string, within?: string) => {
      const ok = await waitFor(`button "${t}"${within ? ` in ${within}` : ""}`,
        () => cdp!.evaluate<boolean>(JS.clickByText(t, within)));
      return ok;
    };
    const waitText = async (t: string) => {
      try {
        return await waitFor(`text "${t}"`, async () => has(await text(), t));
      } catch (e) {
        console.log(dim(`\n--- page text when waiting for "${t}" ---\n${(await text()).slice(0, 2500)}\n---\n`));
        throw e;
      }
    };

    await cdp.send("Page.navigate", { url: BASE });
    await waitText("Agree on what counts as done");
    check("app loads on a normal laptop viewport", true);

    await waitText("Run an automatic job");
    const home = await text();
    check("persistent simulation banner is present", has(home, "Local simulation") && has(home, "test funds with no value"));
    check("the automatic job is the primary action", has(home, "Run an automatic job") && has(home, "Run a job that satisfies the checklist"));
    check("batch import and template reuse are offered",
      has(home, "Use your own batch") && has(home, "Import and run it automatically"));
    check("advanced demonstration is collapsed, not the main story", has(home, "Advanced demonstration"));
    check("appearance follows the system by default, with a manual override",
      has(home, "Auto") && has(home, "Light") && has(home, "Dark"));
    await shot("01-home");

    // ---- conforming delivery, in one click
    await clickText("Run a job that satisfies the checklist");
    await waitText("the contract paid the provider");
    const auto = await text();
    check("one click runs the whole job to payment", has(auto, "the contract paid the provider"));
    // The step list is a log returned when the run completes, not a live stream. The interface
    // says so, and this check is named accordingly.
    check("the completed run lists every step it took",
      has(auto, "Buyer proposed job") && has(auto, "Provider agent re-derived the agreement") && has(auto, "same transaction"));
    check("the interface does not claim the step list is live", has(auto, "it is a log, not a live feed"));
    check("party labels are human-readable, with addresses on expansion",
      has(auto, "Buyer agent") && has(auto, "Provider agent") && !/0x[0-9a-fA-F]{40}/.test(auto));
    await shot("02-automatic");

    await clickText("Inspect each step");
    await waitText("The agreement");
    const agreement = await text();
    check("agreement step shows the coverage report", has(agreement, "4 of 4 clauses are executable"));
    check("agreement step shows all four plain-language clauses",
      ["exactly 12 rows", "appears exactly once", "exactly the price", "strictly increasing"].every((s) => has(agreement, s)));
    await shot("02-agreement");

    // A light-mode capture, since the design must hold in both.
    await clickText("Light");
    await sleep(320);
    await shot("13-light-steps");
    await cdp.evaluate("window.scrollTo(0,0)");
    await sleep(240);
    await shot("14-light-hero");
    await clickText("Auto");
    await sleep(200);

    const checksText = await text();
    check("the inspector shows every rule as satisfied", has(checksText, "All four rules are satisfied"));
    check("the settled record says the contract decided, not the page",
      has(checksText, "the money moved on the contract's own evaluation"));
    check("payment step reports the real outcome", has(checksText, "Released to the provider agent"));
    check("balance change is shown", /\+25 mUSD/.test(checksText));
    await shot("03-checks-pass");
    await shot("04-paid");

    // ---- refresh recovers real chain state and does not repeat a financial action
    const balancesBefore = await (await fetch(`${BASE}/api/state`)).json();
    await cdp.send("Page.reload");
    await waitText("Agree on what counts as done");
    await clickText("#1");
    await waitText("the contract paid the provider");
    const afterReload = await text();
    check("a page refresh redraws the real terminal state", has(afterReload, "the contract paid the provider"));
    const balancesAfter = await (await fetch(`${BASE}/api/state`)).json();
    check("a refresh repeats no financial action",
      JSON.stringify(balancesBefore.balances) === JSON.stringify(balancesAfter.balances));

    // ---- flawed delivery, also in one click
    await clickText("Run one that does not");
    await waitText("the contract refunded the buyer");
    const rejected = await text();
    check("a flawed delivery refunds the buyer and names the rule",
      has(rejected, "the contract refunded the buyer") && has(rejected, "must strictly increase"));
    check("two different jobs hold two different outcomes at once",
      has(rejected, "#1") && has(rejected, "#2"));
    await shot("05-rejected");

    // ---- import a fresh batch and carry it all the way through payment and evidence
    //
    // IDs 8801-8803 appear in no fixture, so nothing about this job can come from a committed
    // example. The earlier version of this check stopped at "an agreement was created", which is
    // why a funded imported job that could never be delivered went unnoticed.
    await cdp.evaluate(`(() => {
      const el = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, JSON.stringify([
        { productId: 8803, priceCents: 4242 },
        { productId: 8801, priceCents: 105 },
        { productId: 8802, priceCents: 99999 }
      ], null, 2));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickText("Import and run it automatically");
    await waitText("the contract paid the provider");
    const imported = await text();
    check("an imported batch runs through to payment",
      has(imported, "Imported batch") && has(imported, "the contract paid the provider"));
    await shot("10-imported-batch");

    await clickText("Export and verify an evidence bundle");
    await waitText("rules reproduced");
    const importedEvidence = await text();
    check("the imported batch produces evidence that verifies offline",
      has(importedEvidence, "rules reproduced: pass") && has(importedEvidence, "bundle internally consistent: pass"));
    check("the imported batch's evidence does not claim settlement was checked in the browser",
      has(importedEvidence, "on-chain settlement: not checked"));

    await clickText("Steps");
    await waitText("The delivery");
    const importedRows = await text();
    check("an imported batch reuses the fixed template",
      has(importedRows, "exactly 3 rows") && has(importedRows, "strictly increasing order"));
    check("the imported batch delivered its own rows, sorted",
      has(importedRows, "8801") && has(importedRows, "8802") && has(importedRows, "8803"));
    await shot("11-imported-settled");
    await clickText("Overview");

    // ---- revisit an earlier paid job after later jobs have completed
    //
    // Job #1 was paid before jobs #2 and #3 existed. Its reported movements must still be its own.
    // They previously came from (wallet balance now − wallet balance at creation), so every later
    // job inflated every earlier one and eventually invalidated their evidence.
    await clickText("#1");
    // Wait for the panel to actually be job #1: job #3 is also paid, so waiting on the outcome
    // sentence alone can return while the previous job is still on screen.
    await waitFor("job #1 panel", async () => {
      const t = await text();
      return has(t, "job #1") && has(t, "conforming delivery");
    });
    const revisited = await text();
    check("an earlier paid job still reports its own payment after later jobs completed",
      /\+25 mUSD/.test(revisited) && !/\+50 mUSD/.test(revisited) && !/\+75 mUSD/.test(revisited));
    check("wallet totals are shown separately from a job's own movements",
      has(revisited, "Current wallet totals") && has(revisited, "Totals across every job in this session"));

    await clickText("Export and verify an evidence bundle");
    await waitText("displayed job id matches the terms");
    const revisitedEvidence = await text();
    check("the exported bundle belongs to the job on screen",
      has(revisitedEvidence, "displayed job id matches the terms") &&
      has(revisitedEvidence, "job 1 vs terms 1"));
    check("the earlier job's evidence still verifies after later activity",
      has(revisitedEvidence, "rules reproduced: pass") && has(revisitedEvidence, "bundle internally consistent: pass"));
    check("the earlier job's evidence still reports its own amount",
      has(revisitedEvidence, "the payout was the agreed amount, to the party this outcome requires") &&
      has(revisitedEvidence, "25000000 out") &&
      has(revisitedEvidence, "25000000 in against an agreed 25000000"));
    check("the earlier job's totals are reconciled with its own movements",
      has(revisitedEvidence, "the reported totals are what the movements add up to") &&
      has(revisitedEvidence, "balance changes equal the movements they are derived from"));
    await shot("12-revisited-earlier-job");

    // ---- unsupported clause (advanced panel)
    await clickText("Advanced demonstration");
    await waitText("Other fixtures");
    await clickText("A clause software cannot check");
    await waitText("This job cannot be created");
    const blockedScope = await text();
    check("an unsupported clause blocks the automatic flow",
      has(blockedScope, "Make the product descriptions persuasive") && has(blockedScope, "cannot be created"));
    check("no silent-drop option is offered", has(blockedScope, "no button that quietly deletes the clause"));
    check("no automatic path revises the clause for you", has(blockedScope, "no automatic path that revises it"));
    check("the exact pack version being approved is named",
      has(blockedScope, "You would be approving") && has(blockedScope, "pack version 2"));
    await shot("06-unsupported-scope");

    await clickText("Approve that revised pack and create the job");
    // The job lands on the summary panel; the clause detail lives in the step-by-step view.
    await waitText("This job is still in progress");
    await clickText("Inspect each step");
    await waitText("excluded by revision");
    const revised = await text();
    check("scope revision keeps the clause visible and marked", has(revised, "excluded by revision"));
    await shot("07-scope-revised");

    // ---- blocked action
    await clickText("The deployer tries to force a verdict");
    await waitText("There is no owner, no admin");
    const blockedText = await text();
    check("a blocked action reports the contract's real response",
      has(blockedText, "balances unchanged: true") || has(blockedText, "unchanged: true"));
    await shot("08-blocked-action");

    // ---- run the agent pair from the UI
    await clickText("fail-order", "details.bay-panel");
    await waitText("[provider]");
    const agents = await text();
    // Also a log returned on completion, not a live stream. Named accordingly.
    check("the two agent programs run and report their own output",
      has(agents, "[buyer]") && has(agents, "[provider]") && has(agents, "validated against the stored terms"));
    await shot("09-agents");

    // ---- contrast
    //
    // This product's honest disclosures are only honest if they are legible. A redesign that
    // quietly greys them out would undermine the thing four reviews were about, so the contrast
    // of the disclosure bar and every note is measured rather than eyeballed.
    const contrast = await cdp.evaluate<{ worst: number; offenders: string[] }>(`(() => {
      const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const parse = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
      // Composite alpha properly: a tinted row is mostly the surface behind it, not the tint.
      const bgOf = (el) => {
        if (!el) return [255, 255, 255];
        const p = parse(getComputedStyle(el).backgroundColor);
        const rgb = p.slice(0, 3);
        const a = p.length > 3 ? p[3] : 1;
        if (rgb.length < 3) return bgOf(el.parentElement);
        if (a >= 0.999) return rgb;
        const under = bgOf(el.parentElement);
        return rgb.map((c, i) => c * a + under[i] * (1 - a));
      };
      const ratio = (a, b) => {
        const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b));
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const targets = [...document.querySelectorAll('.disclosure .terms *, .note, .clause .n, .finding .d, .hint, .facts dt, caption')];
      let worst = 99; const offenders = [];
      for (const el of targets) {
        if (!el.textContent || !el.textContent.trim()) continue;
        if (el.offsetParent === null) continue;
        const r = ratio(parse(getComputedStyle(el).color), bgOf(el));
        if (r < worst) worst = r;
        if (r < 4.5) offenders.push(el.className + ': ' + r.toFixed(2) + ' — ' + el.textContent.trim().slice(0, 40));
      }
      return { worst: Math.round(worst * 100) / 100, offenders: offenders.slice(0, 6) };
    })()`);
    check("secondary and disclosure text meets WCAG AA contrast", contrast.offenders.length === 0,
      contrast.offenders.length ? contrast.offenders.join(" | ") : `worst measured ratio ${contrast.worst}:1`);

    // ---- house style: no em dashes in anything the page renders
    const emDash = await cdp.evaluate<{ count: number; samples: string[] }>(`(() => {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const samples = []; let count = 0; let n;
      while ((n = walk.nextNode())) {
        const t = n.textContent || "";
        const i = t.indexOf("\u2014");
        if (i < 0) continue;
        count++;
        if (samples.length < 5) samples.push(t.slice(Math.max(0, i - 30), i + 30).trim());
      }
      return { count, samples };
    })()`);
    check("no em dashes in rendered copy", emDash.count === 0,
      emDash.count ? emDash.samples.join(" | ") : "none found");

    // ---- keyboard accessibility
    const focusable = await cdp.evaluate<number>(
      `document.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])').length`,
    );
    check("controls are reachable by keyboard", focusable > 20, `${focusable} focusable controls`);
    const noPositiveTabindex = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('[tabindex]')].every(e => Number(e.getAttribute('tabindex')) <= 0)`,
    );
    check("no control hijacks the tab order", noPositiveTabindex);

    // ---- nothing sensitive leaked into the page
    const leak = await cdp.evaluate<string[]>(`(() => {
      const hay = document.documentElement.outerHTML;
      const found = [];
      if (/privateKey|mnemonic|secretKey/i.test(hay)) found.push('key-like word in DOM');
      if (/\\b0x[0-9a-fA-F]{64}\\b/.test(hay)) {
        // 32-byte hex is expected (digests). Only flag if it is labelled as a key.
        if (/key\\s*[:=]\\s*0x[0-9a-fA-F]{64}/i.test(hay)) found.push('labelled key material in DOM');
      }
      return found;
    })()`);
    check("no key material reaches the browser", leak.length === 0, leak.join(", "));

    const errors = await cdp.evaluate<number>(`window.__smokeErrors ?? 0`);
    check("no uncaught page errors surfaced", errors === 0);
  } finally {
    cdp?.close();
    chrome?.kill();
    server.kill("SIGTERM");
    await sleep(600);
    server.kill("SIGKILL");
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = checks.filter((c) => !c.ok);
  writeFileSync(join(SHOTS, "smoke-results.json"), JSON.stringify({ ranAt: new Date().toISOString(), checks }, null, 2));
  console.log(failed.length === 0
    ? green(`\n  ${checks.length} browser checks passed\n`)
    : red(`\n  ${failed.length} of ${checks.length} browser checks failed\n`));
  process.exit(failed.length === 0 ? 0 : 1);
}

await run();
