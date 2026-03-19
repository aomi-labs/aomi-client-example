/**
 * Momentum / Trend-Following Bot — Entry Point
 *
 * Wires together the strategy engine, market data, and Aomi agent interface.
 * Runs a loop that:
 *   1. Fetches real DEX prices from GeckoTerminal
 *   2. Computes moving averages and trend signals
 *   3. Evaluates allocation rotations (one step at a time)
 *   4. Sends rich, context-aware prompts to the Aomi agent for execution
 *   5. Logs portfolio stats and repeats
 */

import { getChainLabel, loadConfig } from "./config.js";
import { AomiAgent } from "./agent.js";
import { createSigner } from "./signer.js";
import {
  createInitialState,
  evaluate,
  updateState,
  applyTrade,
  getPortfolioStats,
} from "./strategy.js";
import { fetchMarketData } from "./market.js";
import type { StrategyState, TradeAction } from "./types.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Momentum Bot (Aomi Client Demo) ===\n");

  const config = loadConfig();
  const signer = createSigner(config.privateKey, config.rpcUrl, config.chainId);
  const agent = new AomiAgent(config, signer);

  console.log(`[bot] Wallet: ${signer.address}`);
  console.log(`[bot] Chain: ${config.chainId} | RPC: ${config.rpcUrl}`);
  console.log(`[bot] Pair: ${config.riskAsset}/${config.stableAsset}`);
  console.log(`[bot] Fast MA: ${config.fastMaPeriod} ticks | Slow MA: ${config.slowMaPeriod} hours`);
  console.log(`[bot] Spread threshold: ${config.maSpreadThreshold}% | Max drawdown: ${config.maxDrawdown}%`);
  console.log(`[bot] Loop interval: ${config.loopIntervalMs / 1000}s\n`);

  let state = createInitialState(config);
  let running = true;

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[bot] Shutting down...");
    running = false;
    agent.shutdown();
    printReport(state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.connect();

  // Introduce the bot's strategy to the agent
  await agent.chat(
    `I'm running a momentum/trend-following strategy bot on ${getChainLabel(config.chainId)}. ` +
    `I hold ${config.riskAsset} as my risk asset and ${config.stableAsset} as my stable asset. ` +
    `My wallet currently has ~${config.initialRiskAmount} ${config.riskAsset} and ~$${config.initialStableAmount} ${config.stableAsset}. ` +
    `Based on moving average crossover signals, I'll ask you to swap between ${config.riskAsset} and ${config.stableAsset}. ` +
    `You can use any DEX — Uniswap, CoW Swap (gasless via EIP-712), 1inch, or others. ` +
    `I support both regular transaction signing and EIP-712 typed data signing. ` +
    `Please find the best available route and execute my instructions precisely.`,
  );

  // ---------- Main loop ----------
  let tickCount = 0;
  while (running) {
    try {
      tickCount++;
      console.log(`\n--- Tick #${tickCount} ---`);

      // 1. Fetch market data
      const market = await fetchMarketData(config);
      console.log(
        `[market] ${config.riskAsset} price=$${market.price.toFixed(2)} ` +
        `fastMA=$${market.fastMA.toFixed(2)} slowMA=$${market.slowMA.toFixed(2)} ` +
        `spread=${market.maSpreadPct >= 0 ? "+" : ""}${market.maSpreadPct.toFixed(3)}% ` +
        `24h=${market.priceChange24hPct >= 0 ? "+" : ""}${market.priceChange24hPct.toFixed(1)}%`,
      );

      if (market.price === 0) {
        console.warn("[bot] Could not fetch price, skipping tick");
        await sleep(config.loopIntervalMs);
        continue;
      }

      // 2. Update state with latest market data
      state = updateState(state, market);

      // Set avg entry price on first tick
      if (state.avgEntryPrice === 0 && state.riskAssetAmount > 0) {
        state = { ...state, avgEntryPrice: market.price };
      }

      // 3. Evaluate strategy
      const actions = evaluate(config, state, market);

      if (actions.length > 0) {
        // 4. Execute action
        for (const action of actions) {
          console.log(`[bot] Action: ${action.type} — ${action.reason}`);
          try {
            await agent.executeAction(action);
            // 5. Apply trade to state
            state = applyTrade(state, action);
            console.log(`[bot] Trade applied. Allocation: ${state.allocation}`);
          } catch (err) {
            console.error(`[bot] Failed to execute ${action.type}:`, err);
          }
        }

        // Break on emergency exit
        if (actions.some((a) => a.type === "emergency_exit")) {
          console.log("[bot] Emergency exit executed. Stopping.");
          break;
        }
      } else {
        console.log(`[bot] No action needed. Allocation: ${state.allocation}`);
      }

      // 6. Log portfolio stats
      const stats = getPortfolioStats(state, market);
      console.log(
        `[portfolio] value=$${stats.totalValue} risk=${stats.riskPct}% ` +
        `risk_asset=${stats.riskAmount} stables=$${stats.stableAmount} ` +
        `unrealizedPnL=$${stats.unrealizedPnl} realizedPnL=$${stats.realizedPnl} ` +
        `drawdown=${stats.drawdownPct}% trades=${stats.trades}`,
      );
    } catch (err) {
      console.error("[bot] Error in main loop:", err);
    }

    await sleep(config.loopIntervalMs);
  }

  // Final report
  agent.shutdown();
  printReport(state);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printReport(state: StrategyState): void {
  console.log("\n=== Bot Report ===");
  console.log(`Allocation: ${state.allocation}`);
  console.log(`Risk asset: ${state.riskAssetAmount.toFixed(4)} tokens`);
  console.log(`Stables: $${state.stableAmount.toFixed(2)}`);
  console.log(`Portfolio value: $${state.portfolioValueUsd.toFixed(2)}`);
  console.log(`Realized PnL: $${state.realizedPnlUsd.toFixed(2)}`);
  console.log(`High water mark: $${state.highWaterMarkUsd.toFixed(2)}`);
  console.log(`Total trades: ${state.tradeCount}`);
  console.log("==================\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run
main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
