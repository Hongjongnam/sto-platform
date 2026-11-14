# sto-platform

Security token contracts (ERC-3643 / ERC-1400) with DvP settlement on a permissioned Hyperledger Besu network.

> The contracts in this repository have not been audited. Do not use them in production.

## Repository layout

```
contracts/     Hardhat project: Solidity sources, tests, scripts
infra/besu/    Local 4-validator QBFT network (Docker Compose)
```

## Requirements

- Node.js 22.13 or later
- Docker with Compose v2

## Contracts

```bash
cd contracts
npm ci
npm run build        # compile
npm test             # run the test suite
npm run coverage     # tests with a coverage report
npm run size         # deployed bytecode size against the 24,576-byte limit
npm run typecheck    # compile, then type-check tests and scripts
```

Static analysis uses [Slither](https://github.com/crytic/slither):

```bash
pip install slither-analyzer
slither . --fail-medium
```

Toolchain: Hardhat 3, Solidity 0.8.34 (EVM target `cancun`), OpenZeppelin Contracts 5.6, ethers v6, Mocha.

### Architecture

```
                 ┌──────────────────────┐
                 │   IdentityRegistry   │  wallet -> investor, KYC status
                 └──────────▲───────────┘
                            │ isVerified / investorOf
┌──────────────┐   ┌────────┴───────────┐   canTransfer   ┌───────────────────┐
│ ERC1967Proxy ├──►│   SecurityToken    ├────────────────►│ ModularCompliance │
└──────────────┘   │  (UUPS, ERC-7201)  │                 └─────────┬─────────┘
                   └────────▲───────────┘                           │ moduleCheck
                            │ investorBalanceOf / holderCount       ▼
                            └──────────────────────────  MaxBalance · MaxHolders · CountryAllow
```

The token keeps the per-investor aggregates; rule modules are stateless and read them. Rules can therefore be added to, removed from or replaced on a live token without migrating any state.

Audited OpenZeppelin components are used wherever one exists: `ERC20Upgradeable`, `AccessControlDefaultAdminRulesUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, `Checkpoints`, `EIP712`, `ECDSA`, `Ownable2Step`. Only the securities-specific logic is written here.

### IdentityRegistry

Maps wallets to investors. A trusted KYC issuer signs an EIP-712 claim off-chain and a registrar submits it; no personal data is stored on-chain.

```
InvestorClaim(address wallet, bytes32 investorId, uint16 country, uint8 investorType, uint64 expiry, uint256 nonce)
```

| Rule | Behaviour |
|---|---|
| Who can sign | Only issuers added by the admin with `setTrustedIssuer` |
| Who can submit | `REGISTRAR_ROLE` |
| Replay protection | EIP-712 domain (chain ID and contract address) plus a per-wallet nonce |
| Investor vs. wallet | `investorId` is an opaque hash of an off-chain identifier; several wallets can share one investor |
| Re-linking | A wallet stays linked to the investor it was first registered for; renewals must carry the same `investorId` |
| Expiry | `isVerified` turns false once `expiry` passes |
| Revocation | `revokeIdentity` clears verification but keeps the wallet-investor link, so balances can still be attributed |
| Issuer removal | Identities already signed by a removed issuer stay valid until they expire or are revoked |

Investor types: `0` retail, `1` qualified, `2` professional. Country is the ISO 3166-1 numeric code.

Slither's `timestamp` detector is disabled in `slither.config.json`: identity expiry is time-based by design.

### SecurityToken

An ERC-20 with zero decimals that follows the ERC-3643 model. Deployed behind a UUPS proxy; state lives in an ERC-7201 namespaced slot.

**Roles**

| Role | Can do |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Grant and revoke roles, replace the compliance contract. Transfer is two-step with a configurable delay |
| `ISSUER_ROLE` | `mint`, `burn` |
| `ENFORCER_ROLE` | Freeze accounts and balances, `forcedTransfer`, `recoveryAddress` |
| `PAUSER_ROLE` | `pause`, `unpause` |
| `REGISTRAR_ROLE` | `setRegisteredSupply` |
| `UPGRADER_ROLE` | Authorise implementation upgrades |

Every privileged function takes a `bytes32 reason` and emits an event with the operator and the reason.

**Validation**

Transfers, mints and burns all pass through one function, which checks in this order:

1. the token is not paused
2. the receiver is verified
3. the receiver is not frozen
4. the sender is verified
5. the sender is not frozen
6. the sender's free balance (balance minus frozen tokens) covers the amount
7. compliance accepts the movement
8. for a mint, the new total supply does not exceed the registered supply

Only `forcedTransfer` and `recoveryAddress` bypass this path.

**Behaviour in specific situations**

| Situation | Behaviour |
|---|---|
| Sender's KYC expired or was revoked | Cannot transfer. The balance stays; it can move again after re-verification or by forced transfer |
| Mint | Receiver must be verified, not frozen and accepted by compliance; total supply stays within the registered supply |
| Burn | No identity check. Only the free balance of a non-frozen account can be burned |
| Forced transfer | Receiver must be verified. Pause, freezes and compliance are skipped. Frozen tokens are released only as far as needed |
| Wallet recovery | New wallet must be verified and belong to the same investor. Balance, frozen amount and frozen flag move; the lost wallet is cleared |
| Paused | Transfers, mints and burns stop. Freezing, forced transfer and recovery stay available |
| Frozen account | Cannot send, receive or be burned from |

**Investor aggregates**

`investorBalanceOf(investorId)` is the combined balance of all wallets of an investor and `holderCount()` is the number of investors with a non-zero balance. Both are updated on every movement, including forced transfers and recovery. Movements between wallets of the same investor and zero-value movements leave them unchanged.

**Registered supply**

`registeredSupply` is the amount registered off-chain. Minting cannot take the total supply above it, and it cannot be set below the current total supply.

**Snapshots**

`balanceOfAt(account, blockNumber)` and `totalSupplyAt(blockNumber)` return values as of the end of a past block.

### ModularCompliance

Holds up to ten rule modules. A movement is allowed only if every module accepts it. `firstFailingModule` tells off-chain callers which rule rejected a movement.

| Module | Rule |
|---|---|
| `MaxBalanceModule` | An investor's combined balance may not exceed the cap for their investor type. A type with no cap cannot receive |
| `MaxHoldersModule` | The number of holding investors may not exceed the cap. Existing holders can always receive, and a holder can hand over their whole position |
| `CountryAllowModule` | Only investors from allowed countries can receive |

### Tests

| Suite | What it covers |
|---|---|
| `IdentityRegistry.test.ts` | Signed claims, replay protection, expiry, revocation, investor links |
| `Compliance.test.ts` | Module management and each rule, including a rule added to a token that already has holders |
| `SecurityToken.test.ts` | Every row of the behaviour table, roles, snapshots, upgrade with state preserved |
| `Invariants.test.ts` | 400 seeded random operations per seed (transfers, mints, burns, freezes, forced transfers, recovery, KYC revocation, pause), checking after every 20 steps that: balances sum to the total supply, total supply stays within the registered supply, frozen never exceeds balance, investor aggregates match wallet balances, the holder count is exact, and unverified wallets are never credited |

## Local network

A four-validator QBFT network with a one-second block time, zero gas price and account permissioning.

```bash
cd infra/besu
./generate.sh            # validator keys, genesis.json, static-nodes.json -> ./network (not committed)
docker compose up -d     # JSON-RPC on http://127.0.0.1:8545 (node1 only, bound to localhost)
docker compose down -v   # stop and delete chain data
```

| Setting | Value |
|---|---|
| Consensus | QBFT, 4 validators (tolerates 1 faulty validator) |
| Chain ID | 20270 |
| Block time | 1 second, immediate finality |
| Gas price | 0 (`zeroBaseFee`, `--min-gas-price=0`) |
| Hard fork | Cancun from genesis |
| Permissioning | Only accounts in `permissions_config.toml` can submit transactions |

`permissions_config.toml` lists the first ten accounts of the standard development mnemonic. Replace them before using the network for anything other than local development. After editing the file, copy it into each `network/node*/` directory and restart the nodes.

### Smoke test

Deploys `USDC`, mints, and checks that a transaction from an account outside the allowlist is rejected.

```bash
cd contracts
BESU_RPC_URL=http://127.0.0.1:8545 \
BESU_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
npx hardhat run scripts/network-smoke.ts --network besu
```

The key above is account #0 of the development mnemonic and is public.
