import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeployConfig, Deployment } from "./deploy.js";

const ROOT = join(import.meta.dirname, "..", "..");

export function loadConfig(): DeployConfig {
  const path = process.env.DEPLOY_CONFIG ?? join(ROOT, "scripts", "config", "local.json");
  return JSON.parse(readFileSync(path, "utf8")) as DeployConfig;
}

export function deploymentPath(networkName: string): string {
  return join(ROOT, "deployments", `${networkName}.json`);
}

export function saveDeployment(networkName: string, deployment: Deployment): string {
  const path = deploymentPath(networkName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
  return path;
}

export function loadDeployment(networkName: string): Deployment {
  const path = deploymentPath(networkName);
  if (!existsSync(path)) throw new Error(`no deployment recorded for network "${networkName}" (${path})`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}
