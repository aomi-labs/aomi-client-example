/**
 * Aomi Agent Interface
 *
 * Wraps AomiClient to send trade commands to the Aomi backend agent
 * and process responses/events. The agent understands natural language
 * trade instructions and executes them on-chain via tool calls.
 *
 * When the agent returns an InlineCall with type "wallet_tx_request",
 * this module signs the transaction locally and sends the result back.
 */

import {
  AomiClient,
  type AomiMessage,
  type ApiSSEEvent,
  type ApiSystemEvent,
  isInlineCall,
  isSystemNotice,
  isSystemError,
} from "@aomi-labs/client";
import type { BotConfig } from "./config.js";
import type { MarketData, TradeAction } from "./types.js";
import {
  type Signer,
  parseTxPayload,
  sendTransaction,
  waitForReceipt,
} from "./signer.js";

export interface AgentResponse {
  messages: AomiMessage[];
  systemEvents: ApiSystemEvent[];
  isProcessing: boolean;
}

interface PendingTx {
  event: ApiSystemEvent;
  payload: unknown;
}

export class AomiAgent {
  private client: AomiClient;
  private sessionId: string | null = null;
  private config: BotConfig;
  private signer: Signer;
  private unsubscribeSSE: (() => void) | null = null;
  private pendingEvents: ApiSSEEvent[] = [];
  private pendingTxs: PendingTx[] = [];

  constructor(config: BotConfig, signer: Signer) {
    this.config = config;
    this.signer = signer;
    this.client = new AomiClient({
      baseUrl: config.aomiBaseUrl,
      apiKey: config.aomiApiKey,
      logger: config.debug ? console : undefined,
    });
  }

  /** Initialize: create a new session and subscribe to SSE updates. */
  async initialize(): Promise<string> {
    const threadId = `delta-neutral-${Date.now()}`;
    const thread = await this.client.createThread(threadId, this.config.publicKey);
    this.sessionId = thread.session_id;

    // Subscribe to real-time SSE events
    this.unsubscribeSSE = this.client.subscribeSSE(
      this.sessionId,
      (event) => {
        this.pendingEvents.push(event);
        if (this.config.debug) {
          console.log("[sse]", event.type, event);
        }
      },
      (error) => {
        console.error("[sse] error:", error);
      },
    );

    console.log(`[agent] Session created: ${this.sessionId}`);
    console.log(`[agent] Wallet: ${this.signer.address}`);
    return this.sessionId;
  }

  /** Send a chat message to the agent and return the response. */
  async chat(message: string): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error("Agent not initialized");

    console.log(`[agent] >>> ${message}`);

    const response = await this.client.sendMessage(this.sessionId, message, {
      namespace: this.config.aomiNamespace,
      publicKey: this.config.publicKey,
      apiKey: this.config.aomiApiKey,
      userState: { address: this.signer.address },
    });

    const messages = response.messages ?? [];
    const systemEvents = response.system_events ?? [];

    // Log agent responses
    for (const msg of messages) {
      if (msg.sender === "agent" && msg.content) {
        console.log(`[agent] <<< ${msg.content.slice(0, 200)}`);
      }
    }

    // Process system events (queue tx requests for signing)
    for (const event of systemEvents) {
      this.handleSystemEvent(event);
    }

    return {
      messages,
      systemEvents,
      isProcessing: response.is_processing ?? false,
    };
  }

  /** Wait for the agent to finish processing (poll state). */
  async waitForCompletion(timeoutMs = 60_000): Promise<AgentResponse> {
    if (!this.sessionId) throw new Error("Agent not initialized");

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.client.fetchState(this.sessionId);

      // Process any new system events while polling
      for (const event of state.system_events ?? []) {
        this.handleSystemEvent(event);
      }

      if (!state.is_processing) {
        return {
          messages: state.messages ?? [],
          systemEvents: state.system_events ?? [],
          isProcessing: false,
        };
      }

      // Sign any pending txs while waiting
      await this.processPendingTransactions();

      await sleep(2000);
    }
    throw new Error("Agent processing timed out");
  }

  /** Execute a trade action by sending a natural language command to the agent. */
  async executeAction(action: TradeAction): Promise<AgentResponse> {
    const message = tradeActionToPrompt(action);
    const response = await this.chat(message);

    // Sign any pending transactions from this action
    await this.processPendingTransactions();

    // If the agent is still processing, wait for completion
    if (response.isProcessing) {
      return this.waitForCompletion();
    }
    return response;
  }

  /** Request market data from the agent. */
  async fetchMarketData(token: string): Promise<MarketData> {
    const response = await this.chat(
      `Give me the current market data for ${token}: spot price, perp mark price, current funding rate (per 8h period), and annualized funding rate APR. Respond with just the numbers in format: spot=X perp=X funding=X apr=X`,
    );

    // Parse the agent's response for market data
    const lastAgentMsg = response.messages
      .filter((m) => m.sender === "agent" && m.content)
      .pop();

    if (!lastAgentMsg?.content) {
      throw new Error("No market data response from agent");
    }

    return parseMarketData(lastAgentMsg.content);
  }

  /**
   * Process any pending wallet_tx_request InlineCalls:
   * sign each transaction and send the tx hash back to the agent.
   */
  async processPendingTransactions(): Promise<void> {
    if (!this.sessionId || this.pendingTxs.length === 0) return;

    const txs = [...this.pendingTxs];
    this.pendingTxs = [];

    for (const { payload } of txs) {
      try {
        const txPayload = parseTxPayload(payload);
        console.log(`[signer] Signing tx to=${txPayload.to} value=${txPayload.value ?? "0"}`);

        const hash = await sendTransaction(this.signer, txPayload);
        const receipt = await waitForReceipt(this.signer, hash);

        // Report the signed tx back to the agent
        await this.client.sendSystemMessage(
          this.sessionId,
          JSON.stringify({
            type: "wallet_tx_result",
            hash,
            status: receipt.status,
            blockNumber: receipt.blockNumber.toString(),
          }),
        );

        console.log(`[signer] Tx result sent to agent: ${hash} (${receipt.status})`);
      } catch (err) {
        console.error("[signer] Failed to sign/send transaction:", err);

        // Notify agent of failure
        await this.client.sendSystemMessage(
          this.sessionId,
          JSON.stringify({
            type: "wallet_tx_result",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  /** Get system events that have accumulated via SSE. */
  getSystemEvents(): ApiSystemEvent[] {
    if (!this.sessionId) return [];
    const events: ApiSystemEvent[] = [];
    for (const sse of this.pendingEvents) {
      if (sse.type === "tool_complete" || sse.type === "tool_update") {
        console.log(`[sse] ${sse.type}:`, JSON.stringify(sse).slice(0, 200));
      }
    }
    this.pendingEvents = [];
    return events;
  }

  /** Clean up: unsubscribe SSE, optionally archive thread. */
  async shutdown(): Promise<void> {
    if (this.unsubscribeSSE) {
      this.unsubscribeSSE();
      this.unsubscribeSSE = null;
    }
    if (this.sessionId) {
      try {
        await this.client.archiveThread(this.sessionId);
        console.log(`[agent] Session archived: ${this.sessionId}`);
      } catch {
        // Best effort
      }
    }
  }

  /** Handle a system event — queue wallet_tx_request for signing. */
  private handleSystemEvent(event: ApiSystemEvent): void {
    if (isInlineCall(event)) {
      const { type, payload } = event.InlineCall;
      console.log(`[system] InlineCall: ${type}`, payload);

      if (type === "wallet_tx_request") {
        this.pendingTxs.push({ event, payload });
        console.log(`[system] Queued tx for signing (${this.pendingTxs.length} pending)`);
      }
    } else if (isSystemNotice(event)) {
      console.log(`[system] Notice: ${event.SystemNotice}`);
    } else if (isSystemError(event)) {
      console.error(`[system] Error: ${event.SystemError}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a TradeAction into a natural language prompt for the Aomi agent. */
function tradeActionToPrompt(action: TradeAction): string {
  switch (action.type) {
    case "open_spot_long":
      return `Buy $${action.sizeUsd} worth of ${action.token} spot (market buy).`;
    case "open_perp_short":
      return `Open a $${action.sizeUsd} short perpetual futures position on ${action.token}.`;
    case "close_spot":
      return `Sell all my ${action.token} spot position (market sell).`;
    case "close_perp":
      return `Close my ${action.token} perpetual futures short position entirely.`;
    case "rebalance_spot":
      return `Buy $${action.adjustUsd.toFixed(2)} more ${action.token} spot to rebalance my delta neutral position.`;
    case "rebalance_perp":
      return `Increase my ${action.token} perp short by $${action.adjustUsd.toFixed(2)} to rebalance my delta neutral position.`;
    case "close_all":
      return `URGENT: Close ALL my ${action.reason ? `positions. Reason: ${action.reason}` : "positions immediately."}. Close both the spot position and the perp short.`;
  }
}

/** Parse market data from agent's free-text response. */
function parseMarketData(text: string): MarketData {
  const extract = (pattern: RegExp, fallback: number): number => {
    const match = text.match(pattern);
    return match ? parseFloat(match[1]) : fallback;
  };

  return {
    spotPrice: extract(/spot[=:\s]*\$?([\d.]+)/i, 0),
    perpPrice: extract(/perp[=:\s]*\$?([\d.]+)/i, 0),
    fundingRate: extract(/funding[=:\s]*([-\d.]+)/i, 0),
    fundingRateApr: extract(/apr[=:\s]*([-\d.]+)/i, 0),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
