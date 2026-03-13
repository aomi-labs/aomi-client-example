/**
 * Market Data Fetcher
 *
 * Fetches spot price from CoinGecko (free, no API key).
 * Perp price and funding rate are approximated for the demo.
 */

import type { MarketData } from "./types.js";

const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum",
  BTC: "bitcoin",
  SOL: "solana",
  ARB: "arbitrum",
  OP: "optimism",
  MATIC: "matic-network",
  AVAX: "avalanche-2",
};

/** Fetch market data for a token. */
export async function fetchMarketData(token: string): Promise<MarketData> {
  const id = COINGECKO_IDS[token.toUpperCase()];
  if (!id) throw new Error(`Unknown token: ${token}`);

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);

  const data = await res.json();
  const spotPrice = data[id]?.usd;
  if (!spotPrice) throw new Error(`No price for ${token}`);

  // Approximate perp price (typically slight premium to spot)
  const perpPrice = spotPrice * 1.0005;

  // Approximate funding rate (typical positive funding ~0.01% per 8h)
  const fundingRate = 0.01;
  const fundingRateApr = fundingRate * 3 * 365; // 3 periods/day * 365 days

  return { spotPrice, perpPrice, fundingRate, fundingRateApr };
}
