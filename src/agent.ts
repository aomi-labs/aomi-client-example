/**
 * Aomi Agent Interface
 *
 * Wraps the @aomi-labs/client Session class to send trade commands to the
 * Aomi backend agent and handle wallet signing requests.
 *
 * The Session handles polling, SSE, and wallet request lifecycle automatically.
 * When the agent needs an on-chain transaction signed, it emits a
 * "wallet_tx_request" event which we intercept, sign with viem, and resolve.
 */

import {
  Session,
  type SessionOptions,
  type AomiMessage,
  type WalletRequest,
  type WalletTxPayload,
} from "@aomi-labs/client";
import type { BotConfig } from "./config.js";
import type { TradeAction } from "./types.js";
import {
  type Signer,
  sendTransaction,
  waitForReceipt,
} from "./signer.js";

export class AomiAgent {
  private session: Session;
  private config: BotConfig;
  private signer: Signer;

  constructor(config: BotConfig, signer: Signer) {
    this.config = config;
    this.signer = signer;

    const sessionOptions: SessionOptions = {
      namespace: config.aomiNamespace,
      publicKey: config.publicKey ?? signer.address,
      apiKey: config.aomiApiKey,
      userState: { address: signer.address },
      logger: config.debug ? { debug: console.debug.bind(console) } : undefined,
    };

    this.session = new Session(
      { baseUrl: config.aomiBaseUrl, apiKey: config.aomiApiKey },
      sessionOptions,
    );

    // --- Wire up wallet signing ---

    this.session.on("wallet_tx_request", async (req: WalletRequest) => {
      await this.handleTxRequest(req);
    });

    // --- Logging hooks ---

    this.session.on("system_notice", ({ message }) => {
      console.log(`[system] Notice: ${message}`);
    });

    this.session.on("system_error", ({ message }) => {
      console.error(`[system] Error: ${message}`);
    });

    this.session.on("processing_start", () => {
      if (config.debug) console.log("[agent] Processing started...");
    });

    this.session.on("processing_end", () => {
      if (config.debug) console.log("[agent] Processing ended.");
    });

    console.log(`[agent] Session created: ${this.session.sessionId}`);
  }

  /** Send a chat message and wait for the agent to finish responding. */
  async chat(message: string): Promise<AomiMessage[]> {
    console.log(`[agent] >>> ${message}`);
    const result = await this.session.send(message);

    // Log agent responses
    for (const msg of result.messages) {
      if (msg.sender === "agent" && msg.content) {
        console.log(`[agent] <<< ${msg.content.slice(0, 200)}`);
      }
    }

    return result.messages;
  }

  /** Execute a trade action by sending a natural language command to the agent. */
  async executeAction(action: TradeAction): Promise<AomiMessage[]> {
    const message = tradeActionToPrompt(action);
    return this.chat(message);
  }

  /** Close the session and clean up. */
  shutdown(): void {
    this.session.close();
    console.log(`[agent] Session closed: ${this.session.sessionId}`);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Handle a wallet_tx_request: sign the transaction and resolve/reject. */
  private async handleTxRequest(req: WalletRequest): Promise<void> {
    const payload = req.payload as WalletTxPayload;
    console.log(`[signer] Tx request id=${req.id} to=${payload.to} value=${payload.value ?? "0"}`);

    try {
      const hash = await sendTransaction(this.signer, payload);
      const receipt = await waitForReceipt(this.signer, hash);

      await this.session.resolve(req.id, { txHash: hash });
      console.log(
        `[signer] Tx resolved: ${hash} (block ${receipt.blockNumber}, status: ${receipt.status})`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[signer] Tx failed: ${reason}`);
      await this.session.reject(req.id, reason);
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

