/**
 * Bot configuration — loaded from environment variables with sensible defaults.
 */

import "dotenv/config";
import type { Hex } from "viem";

export interface BotConfig {
  // -- Aomi backend --
  aomiBaseUrl: string;
  aomiApiKey?: string;
  aomiApp: string;
  publicKey?: string;

  // -- EVM wallet --
  privateKey: Hex;
  rpcUrl: string;
  chainId: number;

  // -- Trading pair --
  riskAsset: string;          // e.g. "wSOL"
  riskAssetAddress: string;   // on-chain token address
  stableAsset: string;        // e.g. "USDC"
  stableAssetAddress: string; // on-chain token address

  // -- GeckoTerminal --
  geckoNetwork: string;       // e.g. "eth"
  ohlcvPoolAddress: string;   // pool used for OHLCV candle data

  // -- Strategy params --
  fastMaPeriod: number;       // fast MA window (in samples)
  slowMaPeriod: number;       // slow MA window (in OHLCV candles)
  maSpreadThreshold: number;  // % spread to trigger rotation (e.g. 0.5)
  maxSlippage: number;        // max acceptable slippage % (e.g. 1)
  maxDrawdown: number;        // max drawdown before emergency exit (e.g. 15)
  tradeCooldownMs: number;    // minimum time between trades

  // -- Portfolio --
  initialRiskAmount: number;  // starting risk asset balance (tokens)
  initialStableAmount: number; // starting stable balance (USD)

  // -- Bot --
  loopIntervalMs: number;     // main loop interval
  ohlcvRefreshMs: number;     // how often to refresh OHLCV data
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
    aomiApp: env("AOMI_APP", "default"),
    publicKey: process.env.PUBLIC_KEY,

    privateKey: env("PRIVATE_KEY") as Hex,
    rpcUrl: env("RPC_URL", "https://eth.llamarpc.com"),
    chainId: Number(env("CHAIN_ID", "1")),

    riskAsset: env("RISK_ASSET", "wSOL"),
    riskAssetAddress: env("RISK_ASSET_ADDRESS", "0xD31a59c85aE9D8edEFec411D448f90841571b89c"),
    stableAsset: env("STABLE_ASSET", "USDC"),
    stableAssetAddress: env("STABLE_ASSET_ADDRESS", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),

    geckoNetwork: env("GECKO_NETWORK", "eth"),
    ohlcvPoolAddress: env("OHLCV_POOL_ADDRESS", "0x127452f3f9cdc0389b0bf59ce6131aa3bd763598"),

    fastMaPeriod: Number(env("FAST_MA_PERIOD", "6")),
    slowMaPeriod: Number(env("SLOW_MA_PERIOD", "12")),
    maSpreadThreshold: Number(env("MA_SPREAD_THRESHOLD", "0.5")),
    maxSlippage: Number(env("MAX_SLIPPAGE", "1")),
    maxDrawdown: Number(env("MAX_DRAWDOWN", "15")),
    tradeCooldownMs: Number(env("TRADE_COOLDOWN_MS", "300000")),

    initialRiskAmount: Number(env("INITIAL_RISK_AMOUNT", "39.34")),
    initialStableAmount: Number(env("INITIAL_STABLE_AMOUNT", "99.60")),

    loopIntervalMs: Number(env("LOOP_INTERVAL_MS", "120000")),
    ohlcvRefreshMs: Number(env("OHLCV_REFRESH_MS", "600000")),
    debug: env("DEBUG", "false") === "true",
  };
}

export function getChainLabel(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Ethereum mainnet";
    case 42161:
      return "Arbitrum";
    case 8453:
      return "Base";
    case 10:
      return "Optimism";
    case 137:
      return "Polygon";
    default:
      return `chain ${chainId}`;
  }
}
