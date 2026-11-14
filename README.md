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
