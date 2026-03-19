/**
 * Market data fetcher — uses GeckoTerminal API for real DEX prices.
 *
 * Optimized to minimize API calls (free tier = 30/min):
 *   - Pool endpoint: price + 24h volume + 24h change in ONE call per tick
 *   - OHLCV: refreshed every ohlcvRefreshMs (default 10 min) for slow MA
 *
 * Fast MA is computed from an in-memory price sample buffer.
 * Slow MA is computed from OHLCV hourly candle closes.
 */

import type { BotConfig } from "./config.js";
import type { MarketData, OhlcvCandle, PriceSample } from "./types.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const priceSamples: PriceSample[] = [];
const MAX_SAMPLES = 100;

let cachedOhlcv: OhlcvCandle[] = [];
let lastOhlcvFetchAt = 0;
let lastPrice = 0;

// ---------------------------------------------------------------------------
// Retry helper for rate-limited APIs
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429 && i < retries - 1) {
      const wait = (i + 1) * 3000;
      console.warn(`[market] Rate limited, retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  throw new Error("fetchWithRetry: should not reach here");
}

// ---------------------------------------------------------------------------
// GeckoTerminal fetchers
// ---------------------------------------------------------------------------

/** Fetch pool data — gives price, 24h volume, and price change in one call. */
async function fetchPoolData(
  network: string,
  pool: string
): Promise<{ price: number; volume24h: number; priceChange24hPct: number }> {
  const url = `${GECKO_BASE}/networks/${network}/pools/${pool}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`GeckoTerminal pool error: ${res.status}`);
  const data = await res.json();
  const attrs = data?.data?.attributes;

  const price = parseFloat(attrs?.base_token_price_usd ?? "0");
  if (!price || isNaN(price)) throw new Error("No price from pool data");

  const volume24h = parseFloat(attrs?.volume_usd?.h24 ?? "0") || 0;
  const priceChange24hPct = parseFloat(attrs?.price_change_percentage?.h24 ?? "0") || 0;

  return { price, volume24h, priceChange24hPct };
}

/** Fetch OHLCV candles from a pool. */
async function fetchOhlcv(
  network: string,
  pool: string,
  timeframe: "minute" | "hour" | "day" = "hour",
  aggregate: number = 1,
  limit: number = 24
): Promise<OhlcvCandle[]> {
  const url =
    `${GECKO_BASE}/networks/${network}/pools/${pool}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=${limit}&currency=usd`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV error: ${res.status}`);
  const data = await res.json();
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list.map((c: number[]) => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
}

// ---------------------------------------------------------------------------
// Price sample buffer
// ---------------------------------------------------------------------------

function recordPriceSample(price: number): void {
  priceSamples.push({ price, timestamp: Date.now() });
  if (priceSamples.length > MAX_SAMPLES) {
    priceSamples.shift();
  }
}

// ---------------------------------------------------------------------------
// Moving average
// ---------------------------------------------------------------------------

function calcSMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Fetches current market data including price, MAs, and 24h stats.
 * Uses 1 API call per tick (pool data) + 1 call every ohlcvRefreshMs (OHLCV).
 */
export async function fetchMarketData(config: BotConfig): Promise<MarketData> {
  // 1. Pool data — price + 24h stats in one call
  const pool = await fetchPoolData(config.geckoNetwork, config.ohlcvPoolAddress);
  recordPriceSample(pool.price);

  // 2. Refresh OHLCV if stale (every ohlcvRefreshMs, default 10 min)
  const now = Date.now();
  if (now - lastOhlcvFetchAt > config.ohlcvRefreshMs || cachedOhlcv.length === 0) {
    try {
      cachedOhlcv = await fetchOhlcv(
        config.geckoNetwork,
        config.ohlcvPoolAddress,
        "hour",
        1,
        Math.max(config.slowMaPeriod + 2, 24)
      );
      lastOhlcvFetchAt = now;
    } catch (err) {
      console.warn("[market] OHLCV fetch failed, using cached:", (err as Error).message);
    }
  }

  // 3. Fast MA from recent price samples
  const fastValues = priceSamples.map((s) => s.price);
  const fastMA = calcSMA(fastValues, config.fastMaPeriod);

  // 4. Slow MA from OHLCV closes
  const slowValues = cachedOhlcv.map((c) => c.close);
  const slowMA = calcSMA(slowValues, config.slowMaPeriod);

  // 5. MA spread
  const fastAboveSlow = slowMA > 0 ? fastMA > slowMA : true;
  const maSpreadPct = slowMA > 0 ? ((fastMA - slowMA) / slowMA) * 100 : 0;

  // 6. Price change since last tick
  const priceChangePct = lastPrice > 0 ? ((pool.price - lastPrice) / lastPrice) * 100 : 0;
  lastPrice = pool.price;

  return {
    price: pool.price,
    priceChangePct,
    fastMA,
    slowMA,
    fastAboveSlow,
    maSpreadPct,
    volume24h: pool.volume24h,
    priceChange24hPct: pool.priceChange24hPct,
  };
}
