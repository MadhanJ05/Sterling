/**
 * Disposable local EVM. Ganache in-process, fresh accounts every start.
 *
 * Private keys are generated at startup from fresh entropy, held in memory only, and are never
 * written to disk, logged, exported in an evidence bundle, or sent to the browser. Nothing here
 * touches a real network, a real key or real money.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { JsonRpcProvider, Wallet, Mnemonic, HDNodeWallet, ContractFactory, Contract } from "ethers";
import { loadArtifacts, type Artifacts } from "./compile.ts";
import { registerErrorAbis } from "../shared/errorAbis.ts";

const require = createRequire(import.meta.url);

export const CHAIN_ID = 31337;
/** Every listener this project starts binds here. Nothing is ever exposed off the machine. */
export const HOST = "127.0.0.1";
export const ROLES = ["deployer", "buyer", "provider", "thirdParty"] as const;
export type Role = (typeof ROLES)[number];

export interface LocalChain {
  provider: JsonRpcProvider;
  rpcUrl: string;
  chainId: number;
  wallets: Record<Role, HDNodeWallet>;
  addresses: Record<Role, string>;
  artifacts: Artifacts;
  /** Advances local-chain time. Local simulation device only; it has no real-world analogue. */
  increaseTime(seconds: number): Promise<number>;
  now(): Promise<number>;
  close(): Promise<void>;
}

export async function startLocalChain(opts: { port?: number; quiet?: boolean } = {}): Promise<LocalChain> {
  const Ganache = require("ganache");
  const port = opts.port ?? 0;
  const mnemonic = Mnemonic.fromEntropy(randomBytes(16)).phrase;

  const server = Ganache.server({
    logging: { quiet: true },
    chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000, defaultGasPrice: 0 },
    wallet: { mnemonic, totalAccounts: ROLES.length, defaultBalance: 1000 },
  });
  // Bind explicitly to loopback. `listen(port)` alone binds the RPC to a wildcard address, which
  // put a chain holding unlocked demo accounts on every interface of the machine. The effective
  // binding is asserted in tests/regression-review.test.ts, not merely intended here.
  await server.listen(port, HOST);
  const actualPort = (server.address() as any).port ?? port;
  const rpcUrl = `http://${HOST}:${actualPort}`;

  // cacheTimeout: -1 disables ethers' 250 ms per-request cache. Ganache instamines, so back to
  // back transactions from one account otherwise read a stale nonce and silently collide.
  const provider = new JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "acceptance-local" }, {
    staticNetwork: true,
    pollingInterval: 50,
    cacheTimeout: -1,
  });

  const wallets = {} as Record<Role, HDNodeWallet>;
  const addresses = {} as Record<Role, string>;
  ROLES.forEach((role, i) => {
    const w = HDNodeWallet.fromPhrase(mnemonic, "", `m/44'/60'/0'/0/${i}`).connect(provider);
    wallets[role] = w;
    addresses[role] = w.address;
  });

  const now = async () => {
    const b = await provider.getBlock("latest");
    return b!.timestamp;
  };

  const artifacts = loadArtifacts();
  registerErrorAbis(Object.values(artifacts.contracts).map((c) => c.abi));

  return {
    provider,
    rpcUrl,
    chainId: CHAIN_ID,
    wallets,
    addresses,
    artifacts,
    async increaseTime(seconds: number) {
      await provider.send("evm_increaseTime", [seconds]);
      await provider.send("evm_mine", []);
      return now();
    },
    now,
    async close() {
      provider.destroy();
      await server.close();
    },
  };
}

export interface Deployment {
  policy: Contract;
  escrow: Contract;
  token: Contract;
  addresses: { policy: string; escrow: string; token: string };
}

async function deploy(name: string, artifacts: Artifacts, signer: any, args: unknown[] = []): Promise<Contract> {
  const art = artifacts.contracts[name];
  if (!art) throw new Error(`No artifact for ${name}. Run: npm run compile`);
  const factory = new ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

/**
 * The token is deployed first because the escrow binds it immutably at construction: one escrow
 * deployment serves exactly one payment asset, and the constructor refuses an address with no code.
 */
export async function deployAll(chain: LocalChain, policyName = "CatalogueNormalizationPolicyV1"): Promise<Deployment> {
  const deployer = chain.wallets.deployer;
  const token = await deploy("MockUSD", chain.artifacts, deployer);
  const policy = await deploy(policyName, chain.artifacts, deployer);
  const escrow = await deploy("AcceptanceEscrow", chain.artifacts, deployer, [
    await policy.getAddress(),
    await token.getAddress(),
  ]);
  return {
    policy,
    escrow,
    token,
    addresses: {
      policy: await policy.getAddress(),
      escrow: await escrow.getAddress(),
      token: await token.getAddress(),
    },
  };
}

export function attach(name: string, address: string, artifacts: Artifacts, runner: any): Contract {
  const art = artifacts.contracts[name];
  if (!art) throw new Error(`No artifact for ${name}`);
  return new Contract(address, art.abi, runner);
}
