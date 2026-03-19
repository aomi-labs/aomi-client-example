/**
 * Momentum / Trend-Following Strategy Engine
 *
 * Pure logic: given market data and current state, decides what actions to take.
 * Does NOT execute trades — returns TradeAction[] for the agent layer to execute.
 *
 * Strategy overview:
 *   - Price up (fast MA > slow MA, spread above threshold) → hold risk asset
 *   - Price weakening (spread narrowing) → rotate 25% to stables
 *   - Price dropping (fast crosses below slow) → rotate to 75% stables
 *   - Strong downtrend (spread below -threshold) → 100% stables
 *   - Recovery reverses the steps. Only one step at a time to prevent whipsaw.
 *   - Emergency exit on max drawdown.
 */

import type { BotConfig } from "./config.js";
import type {
  AllocationState,
  MarketData,
  StrategyState,
  TradeAction,
} from "./types.js";

// ---------------------------------------------------------------------------
// Allocation step ordering (used for one-step-at-a-time transitions)
// ---------------------------------------------------------------------------

const ALLOCATION_STEPS: AllocationState[] = [
  "full_risk",
  "reduced_risk",
  "mostly_stable",
  "full_stable",
];

function allocationIndex(a: AllocationState): number {
  return ALLOCATION_STEPS.indexOf(a);
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

export function createInitialState(config: BotConfig): StrategyState {
  const price = 0; // will be filled on first market data tick
  return {
    allocation: "full_risk",
    riskAssetAmount: config.initialRiskAmount,
    stableAmount: config.initialStableAmount,
    avgEntryPrice: 0,
    portfolioValueUsd: 0,
    highWaterMarkUsd: 0,
    tradeCount: 0,
    realizedPnlUsd: 0,
    lastTradeAt: 0,
    prevMarket: null,
  };
}

// ---------------------------------------------------------------------------
// Target allocation from MA signals
// ---------------------------------------------------------------------------

export function getTargetAllocation(
  market: MarketData,
  config: BotConfig
): AllocationState {
  const spread = market.maSpreadPct;
  const threshold = config.maSpreadThreshold;

  if (spread > threshold) {
    // Strong uptrend: fast MA well above slow MA
    return "full_risk";
  } else if (spread > 0) {
    // Weakening but still positive: trim some risk
    return "reduced_risk";
  } else if (spread > -threshold) {
    // Fast MA crossed below slow MA: move mostly to stables
    return "mostly_stable";
  } else {
    // Strong downtrend: full stables
    return "full_stable";
  }
}

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

export function evaluate(
  config: BotConfig,
  state: StrategyState,
  market: MarketData
): TradeAction[] {
  // Need both MAs to have meaningful values
  if (market.fastMA === 0 || market.slowMA === 0) return [];

  // Respect trade cooldown
  const now = Date.now();
  if (now - state.lastTradeAt < config.tradeCooldownMs) return [];

  // Check drawdown emergency exit first
  if (state.highWaterMarkUsd > 0) {
    const currentValue = state.riskAssetAmount * market.price + state.stableAmount;
    const drawdownPct =
      ((state.highWaterMarkUsd - currentValue) / state.highWaterMarkUsd) * 100;
    if (drawdownPct >= config.maxDrawdown && state.riskAssetAmount > 0) {
      return [
        {
          type: "emergency_exit",
          reason: buildEmergencyReason(drawdownPct, market),
          market,
        },
      ];
    }
  }

  // Determine target allocation
  const target = getTargetAllocation(market, config);
  const currentIdx = allocationIndex(state.allocation);
  const targetIdx = allocationIndex(target);

  // Already at target — no action
  if (currentIdx === targetIdx) return [];

  // Move one step at a time
  const nextIdx = currentIdx < targetIdx ? currentIdx + 1 : currentIdx - 1;
  const nextAllocation = ALLOCATION_STEPS[nextIdx];

  // Going toward more stables (selling risk)
  if (nextIdx > currentIdx) {
    const fraction = getRotationFraction(state.allocation, nextAllocation);
    const tokenAmount = state.riskAssetAmount * fraction;
    if (tokenAmount * market.price < 1) return []; // skip dust
    return [
      {
        type: "rotate_to_stable",
        fraction,
        tokenAmount,
        reason: buildRotationReason(state.allocation, nextAllocation, market),
        market,
      },
    ];
  }

  // Going toward more risk (buying risk)
  const fraction = getRotationFraction(state.allocation, nextAllocation);
  const usdAmount = state.stableAmount * fraction;
  if (usdAmount < 1) return []; // skip dust
  return [
    {
      type: "rotate_to_risk",
      fraction,
      usdAmount,
      reason: buildRotationReason(state.allocation, nextAllocation, market),
      market,
    },
  ];
}

// ---------------------------------------------------------------------------
// Fraction to rotate for each step transition
// ---------------------------------------------------------------------------

function getRotationFraction(
  from: AllocationState,
  to: AllocationState
): number {
  // Each step moves ~25% of the total portfolio
  // But the fraction of the *current* holding differs based on direction
  const fromIdx = allocationIndex(from);
  const toIdx = allocationIndex(to);

  if (toIdx > fromIdx) {
    // Moving toward stables — sell fraction of risk asset
    // full_risk → reduced_risk: sell 25% of risk
    // reduced_risk → mostly_stable: sell 67% of remaining risk (~50% of original)
    // mostly_stable → full_stable: sell 100% of remaining risk
    switch (from) {
      case "full_risk": return 0.25;
      case "reduced_risk": return 0.67;
      case "mostly_stable": return 1.0;
      default: return 0;
    }
  } else {
    // Moving toward risk — deploy fraction of stables
    // full_stable → mostly_stable: deploy 33% of stables
    // mostly_stable → reduced_risk: deploy 67% of stables
    // reduced_risk → full_risk: deploy 100% of remaining stables
    switch (from) {
      case "full_stable": return 0.33;
      case "mostly_stable": return 0.67;
      case "reduced_risk": return 1.0;
      default: return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// State updates
// ---------------------------------------------------------------------------

/** Recalculate portfolio value and high water mark after market data update. */
export function updateState(
  state: StrategyState,
  market: MarketData
): StrategyState {
  const portfolioValueUsd =
    state.riskAssetAmount * market.price + state.stableAmount;
  const highWaterMarkUsd = Math.max(state.highWaterMarkUsd, portfolioValueUsd);

  return {
    ...state,
    portfolioValueUsd,
    highWaterMarkUsd,
    prevMarket: market,
  };
}

/** Adjust state after a trade is executed. */
export function applyTrade(
  state: StrategyState,
  action: TradeAction
): StrategyState {
  const updated = { ...state, lastTradeAt: Date.now(), tradeCount: state.tradeCount + 1 };

  switch (action.type) {
    case "rotate_to_stable": {
      // Sold some risk asset for stables
      const usdReceived = action.tokenAmount * action.market.price;
      const costBasis =
        state.avgEntryPrice > 0
          ? action.tokenAmount * state.avgEntryPrice
          : usdReceived;
      updated.riskAssetAmount = state.riskAssetAmount - action.tokenAmount;
      updated.stableAmount = state.stableAmount + usdReceived;
      updated.realizedPnlUsd += usdReceived - costBasis;
      // Move allocation one step toward stable
      const idx = allocationIndex(state.allocation);
      if (idx < ALLOCATION_STEPS.length - 1) {
        updated.allocation = ALLOCATION_STEPS[idx + 1];
      }
      break;
    }
    case "rotate_to_risk": {
      // Bought risk asset with stables
      const tokensReceived = action.usdAmount / action.market.price;
      // Update average entry price
      const totalCost =
        state.avgEntryPrice * state.riskAssetAmount + action.usdAmount;
      const totalTokens = state.riskAssetAmount + tokensReceived;
      updated.avgEntryPrice = totalTokens > 0 ? totalCost / totalTokens : action.market.price;
      updated.riskAssetAmount = totalTokens;
      updated.stableAmount = state.stableAmount - action.usdAmount;
      // Move allocation one step toward risk
      const idx = allocationIndex(state.allocation);
      if (idx > 0) {
        updated.allocation = ALLOCATION_STEPS[idx - 1];
      }
      break;
    }
    case "emergency_exit": {
      // Sell everything to stables
      const exitValue = state.riskAssetAmount * action.market.price;
      const costBasis =
        state.avgEntryPrice > 0
          ? state.riskAssetAmount * state.avgEntryPrice
          : exitValue;
      updated.stableAmount = state.stableAmount + exitValue;
      updated.realizedPnlUsd += exitValue - costBasis;
      updated.riskAssetAmount = 0;
      updated.allocation = "full_stable";
      break;
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Portfolio stats helper
// ---------------------------------------------------------------------------

export function getPortfolioStats(state: StrategyState, market: MarketData) {
  const riskValueUsd = state.riskAssetAmount * market.price;
  const totalValue = riskValueUsd + state.stableAmount;
  const riskPct = totalValue > 0 ? (riskValueUsd / totalValue) * 100 : 0;
  const unrealizedPnl =
    state.avgEntryPrice > 0
      ? state.riskAssetAmount * (market.price - state.avgEntryPrice)
      : 0;
  const drawdownPct =
    state.highWaterMarkUsd > 0
      ? ((state.highWaterMarkUsd - totalValue) / state.highWaterMarkUsd) * 100
      : 0;

  return {
    allocation: state.allocation,
    totalValue: totalValue.toFixed(2),
    riskPct: riskPct.toFixed(1),
    riskAmount: `${state.riskAssetAmount.toFixed(4)} ($${riskValueUsd.toFixed(2)})`,
    stableAmount: state.stableAmount.toFixed(2),
    unrealizedPnl: unrealizedPnl.toFixed(2),
    realizedPnl: state.realizedPnlUsd.toFixed(2),
    drawdownPct: drawdownPct.toFixed(2),
    trades: state.tradeCount,
  };
}

// ---------------------------------------------------------------------------
// Reason builders (rich context strings for agent prompts)
// ---------------------------------------------------------------------------

function buildRotationReason(
  current: AllocationState,
  target: AllocationState,
  market: MarketData
): string {
  const direction = allocationIndex(target) > allocationIndex(current) ? "defensive" : "aggressive";
  const parts: string[] = [];

  if (market.priceChangePct !== 0) {
    const dir = market.priceChangePct > 0 ? "up" : "down";
    parts.push(`price ${dir} ${Math.abs(market.priceChangePct).toFixed(2)}% this tick`);
  }

  parts.push(`fast MA $${market.fastMA.toFixed(2)} vs slow MA $${market.slowMA.toFixed(2)}`);
  parts.push(`spread ${market.maSpreadPct >= 0 ? "+" : ""}${market.maSpreadPct.toFixed(3)}%`);

  if (market.priceChange24hPct !== 0) {
    parts.push(`24h change ${market.priceChange24hPct >= 0 ? "+" : ""}${market.priceChange24hPct.toFixed(1)}%`);
  }

  return `${direction} rotation ${current} → ${target}: ${parts.join(", ")}`;
}

function buildEmergencyReason(drawdownPct: number, market: MarketData): string {
  return (
    `Emergency exit: drawdown ${drawdownPct.toFixed(1)}% exceeds limit. ` +
    `Price $${market.price.toFixed(2)}, ` +
    `24h change ${market.priceChange24hPct >= 0 ? "+" : ""}${market.priceChange24hPct.toFixed(1)}%.`
  );
}
