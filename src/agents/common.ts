/**
 * Shared plumbing for the buyer and supplier programs.
 *
 * These are deterministic programs, not language models. They take no free decisions: given the
 * same job they produce the same bytes every time. The founder controls both of them, and every
 * surface that shows their output says so.
 */
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { loadArtifacts } from "../chain/compile.ts";


export interface Runtime {
  sessionId?: string;
  rpcUrl: string;
  chainId: number;
  addresses: { policy: string; escrow: string; token: string };
  roles: Record<string, string>;
  startedAt: string;
}

/**
 * There is no default path on purpose. A single shared runtime file let a test run silently
 * repoint a live session's agents at a chain that had already been shut down, so every caller now
 * names the session it means.
 */
export function readRuntime(path: string | undefined): Runtime {
  if (!path) {
    throw new Error(
      "No --runtime <path> was given. Agents must be told which session's chain to use; " +
      "there is no global default. They are started by scripts/demo.ts or the demo server.",
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`No local chain runtime at ${path}. Start a session first.`);
  }
}

export interface AgentContext {
  runtime: Runtime;
  provider: JsonRpcProvider;
  wallet: Wallet;
  escrow: Contract;
  token: Contract;
  policy: Contract;
}

/**
 * The agent's signing key arrives through the environment from the orchestrator that started the
 * disposable chain. It is never written to disk, never logged, and never leaves this process.
 */
export function connectAgent(envKeyName: string, runtimePath: string | undefined): AgentContext {
  const key = process.env[envKeyName];
  if (!key) throw new Error(`${envKeyName} is not set. Agents are started by scripts/demo.ts, not by hand.`);
  const runtime = readRuntime(runtimePath);
  const provider = new JsonRpcProvider(
    runtime.rpcUrl,
    { chainId: runtime.chainId, name: "acceptance-local" },
    { staticNetwork: true, cacheTimeout: -1 },
  );
  const wallet = new Wallet(key, provider);
  const artifacts = loadArtifacts();
  const at = (name: string, address: string) =>
    new Contract(address, artifacts.contracts[name]!.abi, wallet);
  return {
    runtime,
    provider,
    wallet,
    escrow: at("AcceptanceEscrow", runtime.addresses.escrow),
    token: at("MockUSD", runtime.addresses.token),
    policy: at("CatalogueNormalizationPolicyV1", runtime.addresses.policy),
  };
}

export function emit(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

export function say(who: string, message: string) {
  process.stderr.write(`  [${who}] ${message}\n`);
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) out[k!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[k!] = argv[++i]!;
      else out[k!] = "true";
    }
  }
  return out;
}

/**
 * The supplier's transformation lives in src/shared/transform.ts so the browser build can use it
 * without pulling this module's Node dependencies. Re-exported here for the agent programs.
 */
export { transform, type FlawKind } from "../shared/transform.ts";
