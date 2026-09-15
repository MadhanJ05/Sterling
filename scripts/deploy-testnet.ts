#!/usr/bin/env node
/**
 * Milestone E: deploy the same contracts to a public testnet.
 *
 * This is a standalone deployment of our own contracts. It is NOT a Virtuals ACP job, and sharing
 * a chain with ACP does not make it one. See docs/acp-status.md.
 *
 * The script refuses to run without an explicitly configured throwaway key and a funded balance.
 * It never prints the key and never writes it into an artifact.
 *
 * Usage: cp .env.example .env && edit it && npm run deploy:testnet [-- --dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, ContractFactory, formatEther } from "ethers";
import { loadArtifacts } from "../src/chain/compile.ts";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";

const DRY = process.argv.includes("--dry-run");
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function loadEnvFile(): Record<string, string> {
  const path = join(PROJECT_ROOT, ".env");
  const out: Record<string, string> = { ...process.env as Record<string, string> };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnvFile();
const missing = ["TESTNET_RPC_URL", "TESTNET_CHAIN_ID", "TESTNET_DEPLOYER_KEY"].filter((k) => !env[k]);

if (missing.length) {
  console.log(bold("\nPublic testnet deployment is not configured. Exact prerequisites:\n"));
  console.log("  1. A throwaway EOA that holds nothing except testnet gas.");
  console.log("  2. Base Sepolia ETH in it. A public faucet is enough; roughly 0.01 ETH covers");
  console.log("     the three deployments plus a full scenario run at typical testnet gas prices.");
  console.log("     (That figure is an estimate from the local gas measurements in evidence/, not");
  console.log("     a measured testnet cost — nothing has been deployed to a public chain yet.)");
  console.log("  3. A working Base Sepolia RPC URL. Re-check the current chain id before trusting");
  console.log("     the default in .env.example; it is not verified at runtime.");
  console.log("  4. Explicit authorisation to spend those funds.");
  console.log(`\n  Then: cp .env.example .env, fill in ${missing.join(", ")}, and rerun.`);
  console.log(dim("\n  Nothing was deployed. The local demo does not depend on any of this.\n"));
  process.exit(1);
}

const provider = new JsonRpcProvider(env.TESTNET_RPC_URL!, undefined, { staticNetwork: true, cacheTimeout: -1 });
const wallet = new Wallet(env.TESTNET_DEPLOYER_KEY!, provider);
const artifacts = loadArtifacts();

const network = await provider.getNetwork();
const expectedChainId = BigInt(env.TESTNET_CHAIN_ID!);
console.log(bold(`\nDeploying to chain ${network.chainId} via ${env.TESTNET_RPC_URL}`));
console.log(dim(`deployer ${wallet.address}`));

if (network.chainId !== expectedChainId) {
  console.log(red(`\nRefusing to deploy: the RPC reports chain ${network.chainId}, but TESTNET_CHAIN_ID says ${expectedChainId}.`));
  process.exit(1);
}
if (network.chainId === 1n || network.chainId === 8453n) {
  console.log(red("\nRefusing to deploy: that is a mainnet. This project is a prototype and has had no audit."));
  process.exit(1);
}

const balance = await provider.getBalance(wallet.address);
console.log(dim(`balance  ${formatEther(balance)} ETH`));
if (balance === 0n) {
  console.log(red("\nRefusing to deploy: the deployer has no gas. Fund it from a public testnet faucet first."));
  process.exit(1);
}

if (DRY) {
  console.log(green("\nDry run: configuration is valid and the deployer is funded. Nothing was sent.\n"));
  process.exit(0);
}

async function deploy(name: string, args: unknown[] = []) {
  const art = artifacts.contracts[name]!;
  const factory = new ContractFactory(art.abi, art.bytecode, wallet);
  const c = await factory.deploy(...args);
  const receipt = await c.deploymentTransaction()!.wait();
  const address = await c.getAddress();
  console.log(green(`  ✓ ${name.padEnd(32)} ${address}  ${dim(`gas ${receipt!.gasUsed}`)}`));
  return { contract: c, address, tx: receipt!.hash, gasUsed: receipt!.gasUsed.toString() };
}

const policy = await deploy("CatalogueNormalizationPolicyV1");
const escrow = await deploy("AcceptanceEscrow", [policy.address]);
const token = env.TESTNET_PAYMENT_TOKEN
  ? { address: env.TESTNET_PAYMENT_TOKEN, tx: null, gasUsed: null }
  : await deploy("MockUSD");

const out = {
  deployedAt: new Date().toISOString(),
  chainId: Number(network.chainId),
  rpcUrlHost: new URL(env.TESTNET_RPC_URL!).host,
  deployer: wallet.address,
  solcVersion: artifacts.solcVersion,
  contractSourcesHash: artifacts.sourcesHash,
  addresses: { policy: policy.address, escrow: escrow.address, paymentToken: token.address },
  deploymentTransactions: { policy: policy.tx, escrow: escrow.tx, paymentToken: token.tx },
  gasUsed: { policy: policy.gasUsed, escrow: escrow.gasUsed, paymentToken: token.gasUsed },
  note: "A standalone deployment of this project's contracts. Not a Virtuals ACP job and not an ACP integration.",
};

const dir = join(PROJECT_ROOT, "deployments");
mkdirSync(dir, { recursive: true });
const path = join(dir, `${network.chainId}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`\n  record -> ${path.replace(PROJECT_ROOT + "/", "")}`);
console.log(dim("  No key material is written to that file.\n"));
