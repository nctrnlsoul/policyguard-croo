// Runtime configuration for the CROO SDK wiring.
//
// This module reads configuration from environment variables by NAME only. It
// never hardcodes any value and never logs secret values. Secrets live in the
// human's OS environment (or a local .env that is gitignored), and this code
// only references them by name.
//
// Validation happens inside the loader functions, not at import time, so that
// importing provider.ts or requester.ts does not throw or do any work. The
// loaders are called from the start functions when a flow actually runs.

import { config as loadDotenv } from "dotenv";
import type { Logger } from "@croo-network/sdk";

// Load a local .env into process.env if one exists. This is a no-op when no
// .env file is present. It does not open any network connection and does not
// print any value.
loadDotenv();

// The exact environment variable names this project uses. Kept as named
// constants so there is a single source of truth and no typos at call sites.
export const ENV_VARS = {
  apiUrl: "CROO_API_URL",
  wsUrl: "CROO_WS_URL",
  sdkKey: "CROO_SDK_KEY",
  requesterSdkKey: "CROO_REQUESTER_SDK_KEY",
} as const;

/**
 * Read a required environment variable by name. Throws a clear error that names
 * the absent variable, without ever printing the value of any variable.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Scrub secret material from a value before it is logged. Removes SDK keys
 * (croo_sk_...) and any `key=...` query parameter (the SDK embeds the SDK key in
 * the WebSocket URL as ?key=...). Returns a string safe to print.
 */
function redactSecrets(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s
    .replace(/croo_sk_[A-Za-z0-9]+/g, "croo_sk_***")
    .replace(/key=[^&\s"']+/g, "key=***");
}

/**
 * Build a Logger for the CROO SDK that redacts secrets from every message and
 * argument before printing. The SDK's default logger prints the WebSocket URL,
 * which embeds the SDK key (wss://.../ws?key=croo_sk_...); passing this logger
 * in the client Config prevents that key from ever reaching stdout. Debug-level
 * logs (raw request URLs) are dropped entirely.
 */
export function createRedactingLogger(): Logger {
  return {
    info: (m, ...a) => console.log(`[croo] ${redactSecrets(m)}`, ...a.map(redactSecrets)),
    warn: (m, ...a) => console.warn(`[croo] ${redactSecrets(m)}`, ...a.map(redactSecrets)),
    error: (m, ...a) => console.error(`[croo] ${redactSecrets(m)}`, ...a.map(redactSecrets)),
    debug: () => {},
  };
}

/**
 * Configuration for the PolicyGuard provider agent. Reads the shared API and
 * WebSocket URLs plus the provider SDK key.
 */
export interface ProviderConfig {
  apiUrl: string;
  wsUrl: string;
  sdkKey: string;
}

/**
 * Configuration for the test requester agent. Reads the shared API and
 * WebSocket URLs plus the separate requester SDK key.
 */
export interface RequesterConfig {
  apiUrl: string;
  wsUrl: string;
  requesterSdkKey: string;
}

/**
 * Load and validate the provider configuration at runtime. Throws if any
 * required variable is missing, naming which one (never its value).
 */
export function loadProviderConfig(): ProviderConfig {
  return {
    apiUrl: requireEnv(ENV_VARS.apiUrl),
    wsUrl: requireEnv(ENV_VARS.wsUrl),
    sdkKey: requireEnv(ENV_VARS.sdkKey),
  };
}

/**
 * Load and validate the requester configuration at runtime. Throws if any
 * required variable is missing, naming which one (never its value).
 */
export function loadRequesterConfig(): RequesterConfig {
  return {
    apiUrl: requireEnv(ENV_VARS.apiUrl),
    wsUrl: requireEnv(ENV_VARS.wsUrl),
    requesterSdkKey: requireEnv(ENV_VARS.requesterSdkKey),
  };
}
