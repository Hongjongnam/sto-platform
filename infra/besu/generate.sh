#!/usr/bin/env bash
# Generates validator keys, the QBFT genesis file and static-nodes.json into ./network.
# The output contains private keys and is not committed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${BESU_IMAGE:-hyperledger/besu:26.9.0}"
OUT="$DIR/network"
SUBNET_PREFIX="172.28.0"

if [ -e "$OUT" ]; then
  echo "network/ already exists. Remove it (and the docker volumes) to regenerate." >&2
  exit 1
fi

TMP="$DIR/.generated"
rm -rf "$TMP"
# The image entrypoint reports "Output directory already exists" after a successful
# run, so success is judged by the generated genesis file rather than the exit code.
docker run --rm -v "$DIR":/work "$IMAGE" operator generate-blockchain-config \
  --config-file=/work/qbft-config.json --to=/work/.generated --private-key-file-name=key \
  >/dev/null 2>&1 || true
if [ ! -f "$TMP/genesis.json" ]; then
  echo "key generation failed" >&2
  exit 1
fi

mkdir -p "$OUT"
cp "$TMP/genesis.json" "$OUT/genesis.json"

i=1
enodes=()
for keydir in "$TMP"/keys/*/; do
  mkdir -p "$OUT/node$i"
  cp "$keydir/key" "$OUT/node$i/key"
  # Besu rewrites the permissions file on reload, so each node gets its own writable copy.
  cp "$DIR/permissions_config.toml" "$OUT/node$i/permissions_config.toml"
  pub="$(sed 's/^0x//' "$keydir/key.pub")"
  enodes+=("\"enode://${pub}@${SUBNET_PREFIX}.1${i}:30303\"")
  i=$((i + 1))
done
rm -rf "$TMP"

( IFS=,; echo "[${enodes[*]}]" ) > "$OUT/static-nodes.json"
echo "generated $((i - 1)) validators in $OUT"
