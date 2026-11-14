#!/usr/bin/env bash
# Returns the demo to its initial state: a fresh set of contracts on the running chain and an
# empty database. The chain itself keeps running; the old contracts are simply left behind.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$DIR/../.."
source "$DIR/lib.sh"

compose stop backend
wait_for_chain
deploy_contracts
compose exec -T postgres psql -U sto -d postgres -q \
  -c "DROP DATABASE IF EXISTS sto WITH (FORCE)" -c "CREATE DATABASE sto"
compose up -d backend
wait_for_backend
echo "reset complete: $(date)"
