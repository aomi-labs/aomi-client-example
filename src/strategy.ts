/**
 * Delta Neutral Strategy Engine
 *
 * Pure logic: given market data and current state, decides what actions to take.
 * Does NOT execute trades — returns TradeAction[] for the agent layer to execute.
 *
 * Strategy overview:
 *   1. Buy spot + short equal-sized perp → net delta ≈ 0
 *   2. Collect funding rate payments (shorts get paid when funding > 0)
 *   3. Rebalance when delta drifts beyond threshold
 *   4. Unwind when funding flips negative or risk limits breach
 */

import type { BotConfig } from "./config.js";
import type { MarketData, Position, StrategyState, TradeAction } from "./types.js";

export function createInitialState(): StrategyState {
  return {
    isActive: false,
    spot: null,
    perp: null,
    netDelta: 0,
    fundingCollectedUsd: 0,
    totalPnlUsd: 0,
    highWaterMarkUsd: 0,
    lastRebalanceAt: 0,
    lastFundingAt: 0,
  };
}

/** Calculate net delta as a fraction of gross exposure. 0 = perfectly hedged. */
export function calcDeltaDrift(state: StrategyState): number {
  if (!state.spot || !state.perp) return 0;
  const grossExposure = state.spot.notionalUsd;
  if (grossExposure === 0) return 0;
  return Math.abs(state.netDelta) / grossExposure;
}

/** Calculate total equity (spot value + perp margin + funding collected) */
export function calcTotalEquity(state: StrategyState, market: MarketData): number {
  let equity = 0;
  if (state.spot) {
    equity += state.spot.size * market.spotPrice;
  }
  if (state.perp) {
    // Perp short PnL: (entry - current) * size
    const perpPnl = (state.perp.entryPrice - market.perpPrice) * state.perp.size;
    equity += state.perp.notionalUsd + perpPnl;
  }
  equity += state.fundingCollectedUsd;
  return equity;
}

/** Decide whether to enter a new delta neutral position. */
export function shouldEnter(config: BotConfig, state: StrategyState, market: MarketData): boolean {
  if (state.isActive) return false;
  // Only enter if funding rate is favorable (positive = shorts get paid)
  if (market.fundingRateApr < config.minFundingRateApr) return false;
  // Only enter if perp is at a premium to spot (positive basis)
  if (market.perpPrice < market.spotPrice) return false;
  return true;
}

/** Generate entry actions: open spot long + perp short. */
export function getEntryActions(config: BotConfig): TradeAction[] {
  return [
    { type: "open_spot_long", sizeUsd: config.positionSizeUsd, token: config.token },
    { type: "open_perp_short", sizeUsd: config.positionSizeUsd, token: config.token },
  ];
}

/** Check if rebalancing is needed and return rebalance actions. */
export function getRebalanceActions(
  config: BotConfig,
  state: StrategyState,
  market: MarketData,
): TradeAction[] {
  if (!state.isActive || !state.spot || !state.perp) return [];

  const drift = calcDeltaDrift(state);
  if (drift < config.rebalanceThreshold) return [];

  // Time gate: don't rebalance more than once per loop interval
  const now = Date.now();
  if (now - state.lastRebalanceAt < config.loopIntervalMs) return [];

  // Calculate how much to adjust to bring delta back to 0
  const spotNotional = state.spot.size * market.spotPrice;
  const perpNotional = state.perp.size * market.perpPrice;
  const diff = spotNotional - perpNotional;

  if (Math.abs(diff) < 10) return []; // too small to bother

  if (diff > 0) {
    // Spot side is larger — increase perp short
    return [{ type: "rebalance_perp", adjustUsd: diff, token: config.token }];
  } else {
    // Perp side is larger — increase spot or reduce perp
    return [{ type: "rebalance_spot", adjustUsd: Math.abs(diff), token: config.token }];
  }
}

/** Check risk limits. Returns a close_all action if breached, empty otherwise. */
export function checkRiskLimits(
  config: BotConfig,
  state: StrategyState,
  market: MarketData,
): TradeAction[] {
  if (!state.isActive) return [];

  const equity = calcTotalEquity(state, market);
  const initialEquity = config.positionSizeUsd * 2; // both legs
  const drawdown = (state.highWaterMarkUsd - equity) / state.highWaterMarkUsd;

  // Max drawdown check
  if (drawdown >= config.maxDrawdown) {
    return [{ type: "close_all", reason: `Max drawdown breached: ${(drawdown * 100).toFixed(1)}%` }];
  }

  // Stop loss check
  const totalReturn = (equity - initialEquity) / initialEquity;
  if (totalReturn <= -config.maxDrawdown) {
    return [{ type: "close_all", reason: `Stop loss triggered: ${(totalReturn * 100).toFixed(1)}%` }];
  }

  return [];
}

/** Check if funding has become unfavorable. Returns close_all if so. */
export function checkFundingExit(
  config: BotConfig,
  market: MarketData,
  consecutiveNegativePeriods: number,
): TradeAction[] {
  // Exit if funding is negative and persists
  if (market.fundingRateApr < 0 && consecutiveNegativePeriods >= 3) {
    return [{ type: "close_all", reason: `Funding negative for ${consecutiveNegativePeriods} periods` }];
  }
  // Exit if funding drops well below minimum threshold
  if (market.fundingRateApr < -config.minFundingRateApr) {
    return [{ type: "close_all", reason: `Funding deeply negative: ${market.fundingRateApr.toFixed(1)}% APR` }];
  }
  return [];
}

/** Update state after new market data (recalculate positions, PnL, etc.) */
export function updateState(
  state: StrategyState,
  market: MarketData,
  fundingPayment?: number,
): StrategyState {
  const updated = { ...state };

  if (state.spot) {
    updated.spot = {
      ...state.spot,
      notionalUsd: state.spot.size * market.spotPrice,
    };
  }
  if (state.perp) {
    updated.perp = {
      ...state.perp,
      notionalUsd: state.perp.size * market.perpPrice,
    };
  }

  // Recalculate net delta (in USD terms)
  const spotDelta = updated.spot ? updated.spot.notionalUsd : 0;
  const perpDelta = updated.perp ? -updated.perp.notionalUsd : 0; // short = negative delta
  updated.netDelta = spotDelta + perpDelta;

  // Track funding
  if (fundingPayment) {
    updated.fundingCollectedUsd += fundingPayment;
    updated.lastFundingAt = Date.now();
  }

  // Update PnL and high water mark
  const equity = calcTotalEquity(updated, market);
  updated.totalPnlUsd = equity - (updated.spot ? updated.spot.entryPrice * updated.spot.size : 0) -
    (updated.perp ? updated.perp.notionalUsd : 0) + updated.fundingCollectedUsd;
  if (equity > updated.highWaterMarkUsd) {
    updated.highWaterMarkUsd = equity;
  }

  return updated;
}
