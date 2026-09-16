/**
 * The chain, running in this tab.
 *
 * On GitHub Pages there is no Node process to host Ganache, so the same EVM runs in the browser
 * instead. This is not a mock or a recording: the bytecode deployed here is the same compiled
 * output the test suite and the CLI demonstration use, transactions are real transactions, and the
 * escrow enforces the same rules. What changes is where it executes.
 *
 * One honest consequence: the buyer and provider cannot be separate operating-system processes in
 * a browser tab. The static build therefore does not offer that demonstration rather than showing
 * the same code in-page under a label that would imply otherwise.
 */
import Ganache from "ganache";
import { BrowserProvider, ContractFactory, Contract, Mnemonic, HDNodeWallet, type Signer } from "ethers";
import artifactsJson from "../../build/artifacts.json";
import { registerErrorAbis } from "../shared/errorAbis.ts";

export const CHAIN_ID = 31337;
export const ROLES = ["deployer", "buyer", "provider", "thirdParty"] as const;
export type Role = (typeof ROLES)[number];

export interface Artifacts {
  solcVersion: string;
  sourcesHash: string;
  contracts: Record<string, { abi: any[]; bytecode: string; deployedBytecode: string }>;
}
export const artifacts = artifactsJson as unknown as Artifacts;

export interface BrowserChain {
  provider: BrowserProvider;
  chainId: number;
  wallets: Record<Role, HDNodeWallet>;
  addresses: Record<Role, string>;
  artifacts: Artifacts;
  signerFor(role: Role): Promise<Signer>;
  increaseTime(seconds: number): Promise<number>;
  now(): Promise<number>;
}

export interface Deployment {
  policy: Contract;
  escrow: Contract;
  token: Contract;
  addresses: { policy: string; escrow: string; token: string };
}

/** Fresh entropy each load. Keys live in this tab only and are never persisted or transmitted. */
function freshMnemonic(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Mnemonic.fromEntropy(bytes).phrase;
}

export async function startBrowserChain(): Promise<BrowserChain> {
  registerErrorAbis(Object.values(artifacts.contracts).map((c) => c.abi));

  const mnemonic = freshMnemonic();
  const eip1193 = (Ganache as any).provider({
    logging: { quiet: true },
    chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000, defaultGasPrice: 0 },
    wallet: { mnemonic, totalAccounts: ROLES.length, defaultBalance: 1000 },
  });

  const provider = new BrowserProvider(eip1193, { chainId: CHAIN_ID, name: "acceptance-browser" }, {
    staticNetwork: true,
    cacheTimeout: -1,
  });

  const wallets = {} as Record<Role, HDNodeWallet>;
  const addresses = {} as Record<Role, string>;
  ROLES.forEach((role, i) => {
    const w = HDNodeWallet.fromPhrase(mnemonic, "", `m/44'/60'/0'/0/${i}`).connect(provider);
    wallets[role] = w;
    addresses[role] = w.address;
  });

  const now = async () => (await provider.getBlock("latest"))!.timestamp;

  return {
    provider,
    chainId: CHAIN_ID,
    wallets,
    addresses,
    artifacts,
    async signerFor(role) { return wallets[role]; },
    async increaseTime(seconds) {
      await eip1193.request({ method: "evm_increaseTime", params: [seconds] });
      await eip1193.request({ method: "evm_mine", params: [] });
      return now();
    },
    now,
  };
}

async function deploy(name: string, signer: Signer, args: unknown[] = []): Promise<Contract> {
  const art = artifacts.contracts[name];
  if (!art) throw new Error(`No artifact for ${name}`);
  const c = await new ContractFactory(art.abi, art.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

/** Token first: the escrow binds it immutably and requires code at that address. */
export async function deployAll(chain: BrowserChain): Promise<Deployment> {
  const deployer = chain.wallets.deployer;
  const token = await deploy("MockUSD", deployer);
  const policy = await deploy("CatalogueNormalizationPolicyV1", deployer);
  const escrow = await deploy("AcceptanceEscrow", deployer, [
    await policy.getAddress(),
    await token.getAddress(),
  ]);
  return {
    policy, escrow, token,
    addresses: {
      policy: await policy.getAddress(),
      escrow: await escrow.getAddress(),
      token: await token.getAddress(),
    },
  };
}
