/**
 * Shared types for the momentum / trend-following bot.
 */

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/** Current portfolio allocation bucket. */
export type AllocationState =
  | "full_risk"      // 100% risk asset
  | "reduced_risk"   // ~75% risk / 25% stable
  | "mostly_stable"  // ~25% risk / 75% stable
  | "full_stable";   // 100% stables

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceSample {
  price: number;
  timestamp: number;
}

export interface MarketData {
  /** Current price of the risk asset in USD. */
  price: number;
  /** Short-term price change % since last tick. */
  priceChangePct: number;
  /** Fast moving average (short window). */
  fastMA: number;
  /** Slow moving average (long window). */
  slowMA: number;
  /** Whether fast MA is above slow MA. */
  fastAboveSlow: boolean;
  /** (fastMA - slowMA) / slowMA as a percentage. */
  maSpreadPct: number;
  /** 24-hour trading volume in USD (if available). */
  volume24h: number;
  /** 24-hour price change percentage (if available). */
  priceChange24hPct: number;
}

// ---------------------------------------------------------------------------
// Strategy state
// ---------------------------------------------------------------------------

export interface StrategyState {
  /** Current allocation bucket. */
  allocation: AllocationState;
  /** Amount of risk asset held (in token units). */
  riskAssetAmount: number;
  /** Amount of stablecoins held (in USD). */
  stableAmount: number;
  /** Weighted average entry price for risk asset position. */
  avgEntryPrice: number;
  /** Total portfolio value in USD (risk + stables). */
  portfolioValueUsd: number;
  /** Peak portfolio value (for drawdown calculation). */
  highWaterMarkUsd: number;
  /** Number of trades executed. */
  tradeCount: number;
  /** Cumulative realized PnL in USD. */
  realizedPnlUsd: number;
  /** Timestamp of last trade. */
  lastTradeAt: number;
  /** Previous tick's market data (for comparison). */
  prevMarket: MarketData | null;
}

// ---------------------------------------------------------------------------
// Trade actions
// ---------------------------------------------------------------------------

export type TradeAction =
  | {
      type: "rotate_to_stable";
      /** Fraction of risk asset to sell (0-1). */
      fraction: number;
      /** Token amount to sell. */
      tokenAmount: number;
      /** Human-readable reason. */
      reason: string;
      /** Market snapshot when decision was made. */
      market: MarketData;
    }
  | {
      type: "rotate_to_risk";
      /** Fraction of stables to deploy (0-1). */
      fraction: number;
      /** USD amount to spend. */
      usdAmount: number;
      /** Human-readable reason. */
      reason: string;
      /** Market snapshot when decision was made. */
      market: MarketData;
    }
  | {
      type: "emergency_exit";
      /** Reason for emergency exit. */
      reason: string;
      /** Market snapshot when decision was made. */
      market: MarketData;
    };
