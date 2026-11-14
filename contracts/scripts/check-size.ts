// Fails when a contract's deployed bytecode exceeds the EIP-170 limit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 24_576;
const WARN_AT = Math.floor(LIMIT * 0.9);
const ROOT = join(import.meta.dirname, "..", "artifacts", "contracts");

function* artifactFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* artifactFiles(path);
    else if (entry.endsWith(".json")) yield path;
  }
}

const rows: { name: string; size: number }[] = [];
for (const file of artifactFiles(ROOT)) {
  const artifact = JSON.parse(readFileSync(file, "utf8"));
  const code: unknown = artifact.deployedBytecode;
  if (typeof artifact.contractName !== "string" || typeof code !== "string") continue;
  const size = (code.length - 2) / 2;
  if (size > 0) rows.push({ name: artifact.contractName, size });
}

rows.sort((a, b) => b.size - a.size);
let failed = false;
for (const { name, size } of rows) {
  const flag = size > LIMIT ? "OVER LIMIT" : size > WARN_AT ? "near limit" : "";
  if (size > LIMIT) failed = true;
  console.log(`${name.padEnd(32)} ${String(size).padStart(6)} bytes  ${flag}`);
}
console.log(`limit: ${LIMIT} bytes`);
if (failed) process.exit(1);
