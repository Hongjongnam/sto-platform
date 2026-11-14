# Shared by up.sh and reset.sh.
RPC_URL="http://127.0.0.1:8545"
MNEMONIC="test test test test test test test test test test test junk"

compose() {
  docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"
}

rpc() {
  curl -s -m 5 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC_URL"
}

wait_for_chain() {
  for _ in $(seq 1 60); do
    rpc eth_blockNumber '[]' | grep -q '"result":"0x[1-9a-f]' && return 0
    sleep 2
  done
  echo "the chain did not start producing blocks" >&2
  return 1
}

# True when the recorded token address has code on the running chain.
deployment_is_live() {
  local token
  token="$(sed -n 's/.*"securityToken": "\(0x[0-9a-fA-F]*\)".*/\1/p' "$ROOT/contracts/deployments/besu.json")"
  [ -n "$token" ] && ! rpc eth_getCode "[\"$token\",\"latest\"]" | grep -q '"result":"0x"'
}

deploy_contracts() {
  (
    cd "$ROOT/contracts"
    [ -d node_modules ] || npm ci
    # The upgrade plugin keeps a per-chain record of implementations; a recreated chain makes
    # it stale, and a fresh deployment does not need it.
    rm -f .openzeppelin/unknown-*.json
    export BESU_RPC_URL="$RPC_URL" BESU_MNEMONIC="$MNEMONIC"
    npx hardhat run scripts/deploy.ts --network besu
    npx hardhat run scripts/accept-handover.ts --network besu
  )
}

wait_for_backend() {
  for _ in $(seq 1 60); do
    curl -s -m 3 http://127.0.0.1:4780/health | grep -q '"status":"ok"' && return 0
    sleep 2
  done
  echo "the backend did not become healthy" >&2
  return 1
}
