/**
 * Delta Neutral Bot — Entry Point
 *
 * Wires together the strategy engine and Aomi agent interface.
 * Runs a loop that:
 *   1. Fetches market data via the Aomi agent
 *   2. Evaluates strategy conditions (entry, rebalance, risk, funding)
 *   3. Executes trade actions through the agent
 *   4. Logs state and repeats
 */

import { loadConfig, type BotConfig } from "./config.js";
import { AomiAgent } from "./agent.js";
import { createSigner } from "./signer.js";
import {
  createInitialState,
  shouldEnter,
  getEntryActions,
  getRebalanceActions,
  checkRiskLimits,
  checkFundingExit,
  updateState,
  calcDeltaDrift,
  calcTotalEquity,
} from "./strategy.js";
import type { MarketData, StrategyState, TradeAction, Position } from "./types.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Delta Neutral Bot (Aomi Client Demo) ===\n");

  const config = loadConfig();
  const signer = createSigner(config.privateKey, config.rpcUrl, config.chainId);
  const agent = new AomiAgent(config, signer);

  console.log(`[bot] Wallet: ${signer.address}`);
  console.log(`[bot] Chain: ${config.chainId} | RPC: ${config.rpcUrl}\n`);

  let state = createInitialState();
  let consecutiveNegFunding = 0;
  let running = true;

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[bot] Shutting down...");
    running = false;
    await agent.shutdown();
    printReport(config, state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Initialize agent session
  try {
    await agent.initialize();
  } catch (err) {
    console.error("[bot] Failed to initialize agent:", err);
    process.exit(1);
  }

  // Introduce the bot's intent to the agent
  await agent.chat(
    `I'm running a delta neutral strategy bot. I will be sending you trade commands for ${config.token}. ` +
    `The strategy: buy spot + short perp of equal size to collect funding rate yield while staying delta neutral. ` +
    `Please execute my trade instructions precisely. Confirm each action.`,
  );

  console.log(`[bot] Strategy: delta neutral on ${config.token}`);
  console.log(`[bot] Position size: $${config.positionSizeUsd} per leg`);
  console.log(`[bot] Rebalance threshold: ${config.rebalanceThreshold * 100}%`);
  console.log(`[bot] Min funding APR: ${config.minFundingRateApr}%`);
  console.log(`[bot] Loop interval: ${config.loopIntervalMs / 1000}s\n`);

  // ---------- Main loop ----------
  while (running) {
    try {
      // 1. Fetch market data
      console.log("\n--- Tick ---");
      const market = await agent.fetchMarketData(config.token);
      console.log(
        `[market] ${config.token} spot=$${market.spotPrice} perp=$${market.perpPrice} ` +
        `funding=${market.fundingRate}% apr=${market.fundingRateApr}%`,
      );

      if (market.spotPrice === 0) {
        console.warn("[bot] Could not parse market data, skipping tick");
        await sleep(config.loopIntervalMs);
        continue;
      }

      // 2. Update state with latest market data
      state = updateState(state, market);

      // 3. If not active, check entry conditions
      if (!state.isActive) {
        if (shouldEnter(config, state, market)) {
          console.log("[bot] Entry conditions met — opening delta neutral position");
          const entryActions = getEntryActions(config);
          await executeActions(agent, entryActions, config, state, market);

          // Update state to reflect opened positions
          state = {
            ...state,
            isActive: true,
            spot: {
              side: "spot",
              direction: "long",
              size: config.positionSizeUsd / market.spotPrice,
              entryPrice: market.spotPrice,
              notionalUsd: config.positionSizeUsd,
            },
            perp: {
              side: "perp",
              direction: "short",
              size: config.positionSizeUsd / market.perpPrice,
              entryPrice: market.perpPrice,
              notionalUsd: config.positionSizeUsd,
            },
            highWaterMarkUsd: config.positionSizeUsd * 2,
            lastRebalanceAt: Date.now(),
          };
          console.log("[bot] Position opened successfully");
        } else {
          console.log("[bot] Entry conditions not met, waiting...");
        }

        await sleep(config.loopIntervalMs);
        continue;
      }

      // --- Position is active ---

      // 4. Check risk limits (highest priority)
      const riskActions = checkRiskLimits(config, state, market);
      if (riskActions.length > 0) {
        console.log("[bot] RISK LIMIT BREACHED");
        await executeActions(agent, riskActions, config, state, market);
        state = { ...state, isActive: false, spot: null, perp: null };
        break;
      }

      // 5. Check funding rate
      if (market.fundingRateApr < 0) {
        consecutiveNegFunding++;
      } else {
        // Estimate funding payment for this period
        if (state.perp) {
          const fundingPayment =
            Math.abs(market.fundingRate / 100) * state.perp.notionalUsd;
          state = updateState(state, market, fundingPayment);
          console.log(
            `[bot] Funding payment: +$${fundingPayment.toFixed(2)} (total: $${state.fundingCollectedUsd.toFixed(2)})`,
          );
        }
        consecutiveNegFunding = 0;
      }

      const fundingExitActions = checkFundingExit(config, market, consecutiveNegFunding);
      if (fundingExitActions.length > 0) {
        console.log("[bot] Exiting due to unfavorable funding");
        await executeActions(agent, fundingExitActions, config, state, market);
        state = { ...state, isActive: false, spot: null, perp: null };
        break;
      }

      // 6. Check rebalance
      const rebalanceActions = getRebalanceActions(config, state, market);
      if (rebalanceActions.length > 0) {
        const drift = calcDeltaDrift(state);
        console.log(`[bot] Delta drift: ${(drift * 100).toFixed(2)}% — rebalancing`);
        await executeActions(agent, rebalanceActions, config, state, market);
        state = { ...state, lastRebalanceAt: Date.now() };
      }

      // 7. Log status
      const equity = calcTotalEquity(state, market);
      const drift = calcDeltaDrift(state);
      console.log(
        `[status] equity=$${equity.toFixed(2)} delta_drift=${(drift * 100).toFixed(2)}% ` +
        `funding_collected=$${state.fundingCollectedUsd.toFixed(2)} pnl=$${state.totalPnlUsd.toFixed(2)}`,
      );

      // Process any system events from SSE and sign pending txs
      agent.getSystemEvents();
      await agent.processPendingTransactions();

    } catch (err) {
      console.error("[bot] Error in main loop:", err);
    }

    await sleep(config.loopIntervalMs);
  }

  // Final report
  await agent.shutdown();
  printReport(config, state);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function executeActions(
  agent: AomiAgent,
  actions: TradeAction[],
  _config: BotConfig,
  _state: StrategyState,
  _market: MarketData,
): Promise<void> {
  for (const action of actions) {
    console.log(`[exec] ${action.type}`, action);
    try {
      await agent.executeAction(action);
    } catch (err) {
      console.error(`[exec] Failed to execute ${action.type}:`, err);
      throw err;
    }
  }
}

function printReport(config: BotConfig, state: StrategyState): void {
  console.log("\n=== Bot Report ===");
  console.log(`Token: ${config.token}`);
  console.log(`Position size: $${config.positionSizeUsd} per leg`);
  console.log(`Funding collected: $${state.fundingCollectedUsd.toFixed(2)}`);
  console.log(`Total PnL: $${state.totalPnlUsd.toFixed(2)}`);
  console.log(`High water mark: $${state.highWaterMarkUsd.toFixed(2)}`);
  console.log(`Active: ${state.isActive}`);
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
