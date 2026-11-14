#!/usr/bin/env bash
# Starts everything: the chain, the database, a fresh deployment of the contracts, then the
# backend and the frontend. Safe to run again; an existing chain and deployment are kept.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$DIR/../.."
source "$DIR/lib.sh"

[ -f "$DIR/.env" ] || echo "JWT_SECRET=$(openssl rand -base64 36 | tr -d '=/+\n')" > "$DIR/.env"
[ -d "$ROOT/infra/besu/network" ] || "$ROOT/infra/besu/generate.sh"

compose up -d node1 node2 node3 node4 postgres
wait_for_chain
[ -f "$ROOT/contracts/deployments/besu.json" ] && deployment_is_live || deploy_contracts
compose up -d --build backend frontend
wait_for_backend
echo "ready: http://localhost:4790"
