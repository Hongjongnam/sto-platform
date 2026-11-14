# sto-platform

Security token contracts (ERC-3643 / ERC-1400) with DvP settlement on a permissioned Hyperledger Besu network.

> The contracts in this repository have not been audited. Do not use them in production.

## Repository layout

```
contracts/        Hardhat project: Solidity sources, tests, scripts
backend/          NestJS API (work in progress)
infra/besu/       Local 4-validator QBFT network (Docker Compose)
infra/postgres/   PostgreSQL for the backend (Docker Compose)
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

### DvPSettlement

Settles the security leg and the cash leg of a trade in one transaction.

| Rule | Behaviour |
|---|---|
| Trade identity | `tradeId` is the hash of the off-chain trade number; a trade number can be registered once |
| Consent | Seller and buyer both sign the exact terms (EIP-712): trade, tokens, quantity, price, expiry. An allowance alone would not prove consent to the price |
| Tokens | Only tokens the admin has allowed can be used for either leg |
| Atomicity | If either transfer fails, including a rejection by the security token's identity or compliance checks, nothing moves and the trade stays pending |
| Retry | A pending trade can be settled again once the cause of the failure is fixed |
| Expiry | An expired trade cannot be settled, only cancelled |

### DividendDistributor

Pays a cash distribution pro rata to balances at a record block. Holders claim their own share, so the cost does not grow with the number of holders and one failed payment cannot block the rest.

- Shares are computed from `balanceOfAt` / `totalSupplyAt`; movements after the record block do not matter.
- A holder must be verified and not frozen at claim time, and can claim once.
- After the claim deadline the issuer sweeps unclaimed amounts and rounding remainders. Claimed plus swept always equals the amount deposited.

### RedemptionManager

Redeems units for cash at a fixed price per unit. The units are burned and the holder is paid in the same transaction.

- Opening a round pulls enough cash to redeem the whole outstanding supply.
- Only verified holders can redeem, and only free units of an account that is not frozen. The token itself refuses to burn frozen units, so redemption cannot be used to get around a freeze.
- After the deadline the issuer takes back the unpaid deposit.

### PartitionToken

A second token following the ERC-1400 family. Where `SecurityToken` centres on *who* may hold units, this one centres on *what kind* of holding a balance is. It uses the same identity registry.

| Standard | Implemented |
|---|---|
| ERC-1410 | Balances and supply per partition, `partitionsOf`, `transferByPartition`, operators |
| ERC-1594 | `issueByPartition`, `redeemByPartition`, `isIssuable`, pre-transfer validation |
| ERC-1644 | `controllerTransferByPartition`, `controllerRedeemByPartition`, `isControllable` |
| ERC-1643 | `setDocument`, `getDocument`, `removeDocument`, `getAllDocuments` |
| ERC-1066 | Reason codes returned by `canTransferByPartition` |

`canTransferByPartition` returns a status code and a reason without reverting, so a caller can explain a rejection before sending a transaction:

| Code | Meaning | Reason |
|---|---|---|
| `0x51` | Transfer would succeed | |
| `0x52` | Insufficient balance in the partition | `INSUFFICIENT_BALANCE` |
| `0x54` | Transfers halted | `PAUSED` |
| `0x55` | Funds locked | `PARTITION_LOCKED` |
| `0x56` | Invalid sender | `SENDER_FROZEN`, `SENDER_NOT_VERIFIED` |
| `0x57` | Invalid receiver | `RECEIVER_NOT_VERIFIED`, `RECEIVER_FROZEN` |
| `0x58` | Invalid operator | `OPERATOR_NOT_AUTHORIZED` |

**Lock-up.** The issuer can lock a partition until a given time. Locked units cannot be transferred, redeemed or converted. The issuer configures which partition a locked one converts into (for example `LOCKUP` to `GENERAL`); once the lock-up ends, holders convert their own units. Controllers can still force a transfer or redemption at any time.

There is no ERC-20 `transfer`: every movement names its partition.

### Tests

| Suite | What it covers |
|---|---|
| `IdentityRegistry.test.ts` | Signed claims, replay protection, expiry, revocation, investor links |
| `Compliance.test.ts` | Module management and each rule, including a rule added to a token that already has holders |
| `SecurityToken.test.ts` | Every row of the behaviour table, roles, snapshots, upgrade with state preserved |
| `DvPSettlement.test.ts` | Signed terms, allowed tokens, atomicity when either leg fails, retry, expiry, cancellation |
| `CorporateActions.test.ts` | Dividend shares, eligibility, deadline and sweep; redemption, frozen units, funding, closing |
| `PartitionToken.test.ts` | Every reason code, operators, lock-up and conversion, controller operations, documents, accounting consistency |
| `Deployment.test.ts` | The deployment and handover library used by the scripts |
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

### Connecting Hardhat

The `besu` network in `hardhat.config.ts` reads two variables:

```bash
export BESU_RPC_URL=http://127.0.0.1:8545
export BESU_MNEMONIC="test test test test test test test test test test test junk"
```

The mnemonic above is the public development mnemonic; its first twenty accounts are the ones in `permissions_config.toml`.

### Smoke test

Deploys `USDC`, mints, and checks that a transaction from an account outside the allowlist is rejected.

```bash
cd contracts
npx hardhat run scripts/network-smoke.ts --network besu
```

## Deployment

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network besu            # as the deployer (account 0)
npx hardhat run scripts/accept-handover.ts --network besu   # as the admin
```

`deploy.ts` deploys and wires all contracts, grants the operational roles, and writes the addresses, the implementation address, the role holders and the first deployment block to `deployments/<network>.json`.

Roles and parameters come from `scripts/config/local.json` (override with `DEPLOY_CONFIG=<path>`):

| Account | Role |
|---|---|
| 0 | Deployer. Holds no privileges once the handover is complete |
| 1 | Admin of every contract |
| 2 | Token issuer |
| 3 | Enforcer |
| 4 | Pauser |
| 5 | Registrar (identity registry and registered supply) |
| 6 | Upgrader |
| 7 | Settlement operator |
| 8 | KYC issuer |
| 9 | Treasury (dividends and redemption) |

**Handover.** The deployer never keeps control:

- Contracts with a plain admin role (identity registry, settlement, dividends, redemption): the deployer grants the admin role to the admin and renounces its own in the same run.
- Compliance and its modules (`Ownable2Step`) and the token (`AccessControlDefaultAdminRules`): the deployer starts a two-step transfer, and nothing changes hands until the admin accepts.

`accept-handover.ts` accepts the pending transfers, applies the configured delay for future admin transfers, and then verifies every contract: the admin is in control, each role is held by the configured account, and the deployer has no role or ownership left. It fails if anything is off.

## Backend

NestJS 12, TypeORM and PostgreSQL 16. The schema changes only through migrations, and the environment is validated at startup.

```bash
cd infra/postgres && docker compose up -d     # PostgreSQL on 127.0.0.1:54320
cd backend
cp .env.example .env                          # set JWT_SECRET to a random value of 32+ characters
npm ci
npm run build && node --env-file=.env dist/main.js
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness and database connectivity |
| `GET /docs` | OpenAPI documentation |

## End-to-end scenario

Runs the whole lifecycle against a fresh deployment and checks the outcome of every step, including the operations that must be rejected.

```bash
cd contracts
npx hardhat run scripts/e2e.ts --network besu
```

| Step | What happens | What must be rejected |
|---|---|---|
| 1 | Registered supply is set; three investors pass KYC | |
| 2 | 600 units are issued | Mint to an unverified wallet; mint above the holding cap |
| 3 | Transfer between investors | Transfer to an unverified wallet |
| 4 | Part of a balance is frozen | Transfer of frozen units |
| 5 | DvP: 10 units against 1,000 USDC, terms signed by both parties | Reuse of the trade number |
| 6 | Dividend paid pro rata to record-block balances | Second claim |
| 7 | Account frozen; court-ordered forced transfer out of it | Transfer from the frozen account |
| 8 | Lost wallet recovered to a new wallet of the same investor | |
| 9 | Redemption: units cancelled against cash | |
| 10 | Balances add up to the total supply; holder count and investor balances are exact | |

Accounts 10 to 14 of the development mnemonic act as investors.
