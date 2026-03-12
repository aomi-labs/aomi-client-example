/**
 * Bot configuration — loaded from environment variables with sensible defaults.
 */

import type { Hex } from "viem";

export interface BotConfig {
  /** Aomi backend URL */
  aomiBaseUrl: string;
  /** API key for non-default namespaces */
  aomiApiKey?: string;
  /** Aomi namespace to use (e.g. a specific agent/protocol) */
  aomiNamespace: string;
  /** Wallet public key */
  publicKey?: string;

  /** EVM private key (hex with 0x prefix) */
  privateKey: Hex;
  /** JSON-RPC URL for the target chain */
  rpcUrl: string;
  /** EVM chain ID */
  chainId: number;

  /** Token to trade (e.g. "SOL", "ETH") */
  token: string;
  /** Notional size in USD for each leg */
  positionSizeUsd: number;
  /** Maximum delta drift (as fraction of position) before rebalance. e.g. 0.05 = 5% */
  rebalanceThreshold: number;
  /** Minimum funding rate (annualized %) to keep the position open */
  minFundingRateApr: number;
  /** Maximum position size in USD across both legs */
  maxPositionUsd: number;
  /** Maximum drawdown (fraction) before emergency close. e.g. 0.10 = 10% */
  maxDrawdown: number;

  /** Strategy loop interval in milliseconds */
  loopIntervalMs: number;
  /** Enable verbose debug logging */
  debug: boolean;
}

export function loadConfig(): BotConfig {
  const env = (key: string, fallback?: string): string => {
    const val = process.env[key] ?? fallback;
    if (val === undefined) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    aomiBaseUrl: env("AOMI_BASE_URL", "https://aomi.dev"),
    aomiApiKey: process.env.AOMI_API_KEY,
    aomiNamespace: env("AOMI_NAMESPACE", "default"),
    publicKey: process.env.PUBLIC_KEY,

    privateKey: env("PRIVATE_KEY") as Hex,
    rpcUrl: env("RPC_URL", "https://eth.llamarpc.com"),
    chainId: Number(env("CHAIN_ID", "1")),

    token: env("TOKEN", "SOL"),
    positionSizeUsd: Number(env("POSITION_SIZE_USD", "1000")),
    rebalanceThreshold: Number(env("REBALANCE_THRESHOLD", "0.05")),
    minFundingRateApr: Number(env("MIN_FUNDING_RATE_APR", "5")),
    maxPositionUsd: Number(env("MAX_POSITION_USD", "10000")),
    maxDrawdown: Number(env("MAX_DRAWDOWN", "0.10")),

    loopIntervalMs: Number(env("LOOP_INTERVAL_MS", "60000")),
    debug: env("DEBUG", "false") === "true",
  };
}
