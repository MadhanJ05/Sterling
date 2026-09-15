/**
 * Compiles every contract with a pinned solc and writes artifacts to build/artifacts.json.
 * No framework: solc-js is called directly so the exact compiler input is visible and recorded.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const solc = require("solc");

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS_DIR = join(ROOT, "contracts");
const BUILD_DIR = join(ROOT, "build");
const ARTIFACTS_PATH = join(BUILD_DIR, "artifacts.json");

export interface Artifact {
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
}
export interface Artifacts {
  solcVersion: string;
  compiledAt: string;
  sourcesHash: string;
  contracts: Record<string, Artifact>;
}

function collectSources(dir: string, acc: Record<string, { content: string }> = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, acc);
    else if (entry.endsWith(".sol")) acc[relative(CONTRACTS_DIR, full)] = { content: readFileSync(full, "utf8") };
  }
  return acc;
}

export function compileAll(force = false): Artifacts {
  const sources = collectSources(CONTRACTS_DIR);
  const sourcesHash = createHash("sha256")
    .update(JSON.stringify(Object.keys(sources).sort().map((k) => [k, sources[k]!.content])))
    .digest("hex");

  if (!force && existsSync(ARTIFACTS_PATH)) {
    const cached = JSON.parse(readFileSync(ARTIFACTS_PATH, "utf8")) as Artifacts;
    if (cached.sourcesHash === sourcesHash && cached.solcVersion === solc.version()) return cached;
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Ganache 7.9.2 tops out at Shanghai; Paris avoids PUSH0/MCOPY entirely so the same
      // artifacts also run on older EVMs. See docs/limitations.md.
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path: string) => {
        // Project sources resolve relative to contracts/; anything else (OpenZeppelin) from
        // node_modules, so the audited library is compiled from the pinned package rather than
        // vendored into this repository.
        for (const base of [CONTRACTS_DIR, join(ROOT, "node_modules")]) {
          const full = join(base, path);
          if (existsSync(full)) return { contents: readFileSync(full, "utf8") };
        }
        return { error: `not found: ${path}` };
      },
    }),
  );

  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  for (const w of (output.errors ?? []).filter((e: any) => e.severity === "warning")) {
    if (!/SPDX|Unused/.test(w.message)) console.warn("[solc warning]", w.formattedMessage?.trim());
  }

  const contracts: Record<string, Artifact> = {};
  for (const file of Object.keys(output.contracts ?? {})) {
    for (const name of Object.keys(output.contracts[file])) {
      const c = output.contracts[file][name];
      contracts[name] = {
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      };
    }
  }

  const artifacts: Artifacts = {
    solcVersion: solc.version(),
    compiledAt: new Date().toISOString(),
    sourcesHash,
    contracts,
  };
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(ARTIFACTS_PATH, JSON.stringify(artifacts, null, 2));
  return artifacts;
}

export function loadArtifacts(): Artifacts {
  return compileAll(false);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = compileAll(true);
  console.log(`solc ${a.solcVersion}`);
  for (const [name, art] of Object.entries(a.contracts)) {
    console.log(`  ${name.padEnd(34)} ${((art.deployedBytecode.length - 2) / 2).toString().padStart(6)} bytes deployed`);
  }
  console.log(`artifacts -> ${relative(ROOT, ARTIFACTS_PATH)}`);
}
