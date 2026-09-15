# Official ACP integration — status

**Status: not integrated. Nothing in this project has ever talked to Virtuals ACP.**

This is a bounded compatibility pass, not a partial integration. The local MVP does not depend on
anything here, and none of it is demonstrated in the demo.

## 1. What was done

A single timeboxed reading of the pinned SDK snapshot
`2b45a88f7ef51d0d80b9425c63bb138e4522926b` of `Virtual-Protocol/acp-node-v2`, on 14 September 2026.
Three files were fetched and read directly: `src/acpAgent.ts`, `src/clients/evmAcpClient.ts`, and
`src/core/acpAbi.ts`. No account was registered, nobody was contacted, and no transaction was sent.

Everything in §2 is quoted from that snapshot. It describes the **SDK's pinned ABI**, which is not
necessarily the currently deployed contract. Re-verify before building on any of it.

## 2. Verified against the pinned source

| Fact | Where | Consequence |
|---|---|---|
| `createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook)` | `acpAbi.ts` | The evaluator is an address, so a **contract** evaluator is possible. |
| `createJobFromOffering` defaults `evaluatorAddress` to `getNoEvaluatorAddress(chainId)` — the zero address on EVM | `acpAgent.ts:760`, documented at `:709–712` | Omitting the evaluator selects **skip-evaluation**: the job auto-completes on submission. The evaluator must be passed explicitly, every time. |
| `submit(uint256 jobId, bytes32 deliverable, bytes optParams)` | `acpAbi.ts` | The digest is **supplied by the caller**. The contract does not compute it and cannot check it against anything. |
| The SDK computes it as `keccak256(toHex(params.deliverable))` on the deliverable **string** | `evmAcpClient.ts:158` | If the deliverable string is a URL, the commitment is to the URL, not to the bytes served there. This breaks content-addressing unless the caller passes a digest of the actual bytes. |
| `jobs(uint256)` returns `(client, status, provider, expiredAt, evaluator, hook, budget, description)` | `acpAbi.ts` | **The submitted digest is not in the getter.** It appears only in `JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)`. An event log is not contract-readable storage, so an on-chain evaluator cannot read what was submitted. |
| One expiry field, `expiredAt` | `acpAbi.ts` | There is no separate delivery deadline and settlement expiry. Timely work can lose its payment while verification is still in progress. Our escrow splits the two for exactly this reason. |
| `whitelistedHooks(address)` / `setHookWhitelist(address,bool)` | `acpAbi.ts` | Custom hooks need to be whitelisted by an admin. |
| `complete(uint256, bytes32 reason, bytes)` and `reject(uint256, bytes32 reason, bytes)`, plus `claimRefund(uint256)` | `acpAbi.ts` | Terminal outcomes, consistent with the ERC-8183 draft's no-appeal shape. |

### An administrative surface exists on the job contract

The pinned ABI exposes:

- `upgradeToAndCall(address,bytes)`, `proxiableUUID()`, `UPGRADE_INTERFACE_VERSION()` and an
  `Upgraded(address indexed implementation)` event — the contract is **UUPS-upgradeable**.
- OpenZeppelin AccessControl: `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, `grantRole`, `revokeRole`.
- `setProvider(uint256,address)`, `setPlatformFee(uint256,address)`, `setEvaluatorFee(uint256)`,
  `setHookWhitelist(address,bool)`.

**Correction, 14 September 2026.** An earlier version of this document stated in bold that "the
provider of an existing job, and therefore the payment recipient, can be changed after creation."
That was an overstatement and it is withdrawn. The ABI shows only that a function with that name
and signature exists. It does not show who may call it, or in which job states. The ERC-8183 draft
restricts the equivalent operation to the Open state, and the deployed implementation would have
to be read to establish actual behaviour. It was not read.

What can be said accurately, and only this:

- An administrative role and an upgrade path exist on the contract. That is a trust assumption any
  integration inherits, and it should be stated when describing the trust model.
- Neither the presence of an admin function nor the presence of an upgrade function is, by itself,
  a vulnerability, and neither is described as one here.
- Establishing what `setProvider` actually permits requires fetching and reading the verified
  implementation source for the deployed proxy. That is listed as a blocker in §4.

The contrast with our own escrow is still worth stating, because it is a tested property rather
than an inference: `AcceptanceEscrow` has no owner, no role, no upgrade path, and no function that
changes a job's recipient. `tests/no-bypass.test.ts` asserts the entire function list.

## 3. What an integration would actually have to solve

ACP has no field for an approved acceptance pack. `description` is a string on chain and the
requirements travel through messaging, so by default the agreed rules are **not** bound on chain.
An honest integration has to bind them, and there are only three shapes:

1. **Off-chain deterministic signer (weakest).** Our checker runs off ACP, and an EOA evaluator
   calls `complete()` or `reject()`. Easy, and it retains signer trust: whoever holds that key can
   sign anything. This must be labelled as a separate, weaker milestone, never as
   contract-enforced.
2. **Contract evaluator reading the event (partial).** A contract evaluator cannot read the
   submitted digest from `jobs()`, so something off-chain must relay it, and the relay is trusted
   for that one value. Better, still not enforcement.
3. **Contract evaluator with its own binding (real enforcement).** The evaluator contract holds its
   own record of the approved pack and source, is handed the actual typed rows, recomputes the
   digest itself, and compares it to what was submitted — which means the submitted digest has to
   reach the contract through a path the contract itself can verify. That is a design problem, not
   an afternoon's wiring, and it is the only version that would deserve the word "enforced."

The local MVP implements shape 3 in its own escrow, where it controls both ends. Reproducing it on
top of ACP is the open work.

## 4. Blockers, and what would clear each

| Blocker | What would clear it |
|---|---|
| No registered ACP agent identity | Registration on the Virtuals platform. Out of scope here: the brief rules out registering accounts. |
| Deployed contract address on Base Sepolia not confirmed | Read it from the SDK's configured `contractAddresses` for chain 84532 against a live deployment, then verify the deployed bytecode matches the pinned ABI. |
| Deployed implementation source not read | Fetch and read the verified source for the proxy implementation, in particular which roles and which job states `setProvider` and `upgradeToAndCall` permit. Until then, no claim about their behaviour is warranted in either direction. |
| Custom hooks require whitelisting | An admin whitelist entry. Needs a request to the platform operator, which is contact, which is out of scope. |
| `ViemProviderAdapter` methods reported as unimplemented | Verify against the current SDK; if still unimplemented, supply our own `IEvmProviderAdapter`. |
| Nothing has been tested against a live ACP contract | Everything above. Until then, no claim about ACP behaviour in this project rests on anything but a reading of pinned source. |

## 5. Deliverable in this repository

`src/acp/adapter.ts` — a narrow interface plus `NotIntegratedAcpAdapter`, whose every method
throws `AcpIntegrationBlocked`. There is no stub that returns plausible values, on purpose: a stub
like that would let a demo look like an ACP integration while being nothing of the kind.

## 6. What must not be said

- That this project integrates with ACP, or has an ACP evaluator. It does not.
- That deploying our contracts to Base Sepolia (milestone E) makes something an ACP job. Sharing a
  chain with ACP is not integration.
- That an off-chain signer version is "contract-enforced". It is signer-enforced.
- That no competitor has ACP distribution. Taste reports a live ACP evaluator integration. That
  assertion was never established and should not be repeated.
