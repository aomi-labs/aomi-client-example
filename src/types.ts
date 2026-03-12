/**
 * Shared types for the delta neutral bot.
 */

export interface Position {
  /** "spot" or "perp" */
  side: "spot" | "perp";
  /** Long or short */
  direction: "long" | "short";
  /** Size in token units */
  size: number;
  /** Entry price in USD */
  entryPrice: number;
  /** Current notional value in USD */
  notionalUsd: number;
}

export interface StrategyState {
  /** Whether the strategy has open positions */
  isActive: boolean;
  /** Spot leg */
  spot: Position | null;
  /** Perp leg */
  perp: Position | null;
  /** Current net delta (spot delta + perp delta). 0 = perfectly hedged */
  netDelta: number;
  /** Cumulative funding collected in USD */
  fundingCollectedUsd: number;
  /** Cumulative PnL in USD */
  totalPnlUsd: number;
  /** High-water mark for drawdown calculation */
  highWaterMarkUsd: number;
  /** Timestamp of last rebalance */
  lastRebalanceAt: number;
  /** Timestamp of last funding collection */
  lastFundingAt: number;
}

export type TradeAction =
  | { type: "open_spot_long"; sizeUsd: number; token: string }
  | { type: "open_perp_short"; sizeUsd: number; token: string }
  | { type: "close_spot"; token: string }
  | { type: "close_perp"; token: string }
  | { type: "rebalance_spot"; adjustUsd: number; token: string }
  | { type: "rebalance_perp"; adjustUsd: number; token: string }
  | { type: "close_all"; reason: string };

export interface MarketData {
  /** Current spot price */
  spotPrice: number;
  /** Current perp mark price */
  perpPrice: number;
  /** Current funding rate (per period, e.g. 8h) */
  fundingRate: number;
  /** Annualized funding rate % */
  fundingRateApr: number;
}
