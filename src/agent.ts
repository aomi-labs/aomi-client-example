/**
 * Aomi Agent Interface
 *
 * Wraps the @aomi-labs/client Session class to send trade commands to the
 * Aomi backend agent and handle wallet signing requests (both transactions
 * and EIP-712 typed data).
 *
 * Uses sendAsync() + event listeners for real-time streaming of agent
 * messages and tool calls, matching the CLI's verbose output behavior.
 */

import {
  Session,
  type SessionOptions,
  type AomiMessage,
  type WalletRequest,
  type WalletTxPayload,
  type WalletEip712Payload,
} from "@aomi-labs/client";
import type { BotConfig } from "./config.js";
import type { TradeAction } from "./types.js";
import {
  type Signer,
  sendTransaction,
  waitForReceipt,
  signEip712,
} from "./signer.js";

export class AomiAgent {
  private session: Session;
  private config: BotConfig;
  private signer: Signer;
  private printedAgentCount = 0;

  constructor(config: BotConfig, signer: Signer) {
    this.config = config;
    this.signer = signer;

    const sessionOptions: SessionOptions = {
      app: config.aomiApp,
      publicKey: config.publicKey ?? signer.address,
      apiKey: config.aomiApiKey,
      userState: { address: signer.address, chainId: config.chainId },
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

    this.session.on("wallet_eip712_request", async (req: WalletRequest) => {
      await this.handleEip712Request(req);
    });

    // --- Streaming output: tool calls ---

    this.session.on("tool_update", (event) => {
      const name = (event.tool_name ?? event.name ?? "unknown") as string;
      const status = (event.status as string) ?? "running";
      console.log(`[tool] ${name}: ${status}`);
    });

    this.session.on("tool_complete", (event) => {
      const name = (event.tool_name ?? event.name ?? "unknown") as string;
      const result = ((event.result ?? event.output) as string) ?? "";
      console.log(`[tool] ${name} → ${result.slice(0, 150)}`);
    });

    // --- Streaming output: agent messages ---

    this.session.on("messages", (messages) => {
      this.printNewAgentMessages(messages);
    });

    // --- System events ---

    this.session.on("system_notice", ({ message }) => {
      console.log(`[system] Notice: ${message}`);
    });

    this.session.on("system_error", ({ message }) => {
      console.error(`[system] Error: ${message}`);
    });

    this.session.on("processing_start", () => {
      console.log("[agent] Processing...");
    });

    this.session.on("processing_end", () => {
      console.log("[agent] Done.");
    });

    // --- Connect wallet so Aomi knows it's live ---
    this.session.resolveWallet(signer.address, config.chainId);

    console.log(`[agent] Session created: ${this.session.sessionId}`);
    console.log(`[agent] Wallet connected: ${signer.address} (chain ${config.chainId})`);
  }

  /**
   * Send a chat message and wait for the agent to finish.
   * Messages and tool calls stream to console in real-time via event listeners.
   */
  async chat(message: string): Promise<AomiMessage[]> {
    console.log(`[agent] >>> ${message.slice(0, 300)}${message.length > 300 ? "..." : ""}`);

    await this.session.sendAsync(message);

    // Wait for processing to end or a wallet request to arrive
    if (this.session.getIsProcessing()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.session.off("processing_end", done);
          this.session.off("wallet_tx_request", done);
          this.session.off("wallet_eip712_request", done);
          resolve();
        };
        this.session.on("processing_end", done);
        this.session.on("wallet_tx_request", done);
        this.session.on("wallet_eip712_request", done);
      });
    }

    return this.session.getMessages();
  }

  /** Execute a trade action by sending a rich contextual prompt to the agent. */
  async executeAction(action: TradeAction): Promise<AomiMessage[]> {
    const message = buildPrompt(action, this.config);
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

  /** Print any new agent messages we haven't printed yet. Skip streaming (partial) messages. */
  private printNewAgentMessages(messages: AomiMessage[]): void {
    const agentMessages = messages.filter(
      (m) => m.sender === "agent" || m.sender === "assistant",
    );
    for (let i = this.printedAgentCount; i < agentMessages.length; i++) {
      const msg = agentMessages[i];
      // Skip still-streaming messages — they're incomplete
      if (msg.is_streaming) break;
      // Print tool results
      if (msg.tool_result) {
        const [name, result] = msg.tool_result;
        console.log(`[tool] ${name} → ${(result ?? "").slice(0, 150)}`);
      }
      // Print agent text
      if (msg.content) {
        console.log(`[agent] <<< ${msg.content}`);
      }
      this.printedAgentCount = i + 1;
    }
  }

  private async handleTxRequest(req: WalletRequest): Promise<void> {
    const payload = req.payload as WalletTxPayload;
    console.log(`[signer] Tx request id=${req.id}`);
    console.log(`[signer]   to:    ${payload.to}`);
    console.log(`[signer]   value: ${payload.value ?? "0"}`);
    console.log(`[signer]   data:  ${payload.data ? payload.data.slice(0, 20) + "..." : "none"}`);
    console.log(`[signer]   chain: ${payload.chainId ?? "default"}`);

    try {
      const hash = await sendTransaction(this.signer, payload);
      console.log(`[signer] Tx broadcast: ${hash}`);
      const receipt = await waitForReceipt(this.signer, hash);
      await this.session.resolve(req.id, { txHash: hash });
      console.log(
        `[signer] Tx confirmed: block=${receipt.blockNumber} status=${receipt.status}`,
      );
    } catch (err: unknown) {
      const error = err as Error & { shortMessage?: string; details?: string; cause?: Error };
      console.error(`[signer] Tx FAILED:`);
      console.error(`[signer]   message: ${error.message}`);
      if (error.shortMessage) console.error(`[signer]   short:   ${error.shortMessage}`);
      if (error.details) console.error(`[signer]   details: ${error.details}`);
      if (error.cause) console.error(`[signer]   cause:   ${error.cause.message}`);
      await this.session.reject(req.id, error.shortMessage ?? error.message);
    }
  }

  private async handleEip712Request(req: WalletRequest): Promise<void> {
    const payload = req.payload as WalletEip712Payload;
    console.log(`[signer] EIP-712 request id=${req.id}`);
    console.log(`[signer]   desc: ${payload.description ?? "n/a"}`);
    console.log(`[signer]   type: ${payload.typed_data?.primaryType ?? "unknown"}`);

    try {
      const signature = await signEip712(this.signer, payload);
      await this.session.resolve(req.id, { signature });
      console.log(`[signer] EIP-712 signed: ${signature.slice(0, 20)}...`);
    } catch (err: unknown) {
      const error = err as Error & { shortMessage?: string; details?: string };
      console.error(`[signer] EIP-712 FAILED:`);
      console.error(`[signer]   message: ${error.message}`);
      if (error.shortMessage) console.error(`[signer]   short:   ${error.shortMessage}`);
      await this.session.reject(req.id, error.shortMessage ?? error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt generation — the showcase
// ---------------------------------------------------------------------------

/**
 * Build a rich, context-aware prompt for the Aomi agent.
 *
 * These prompts demonstrate Aomi's ability to handle flexible, natural-language
 * trade instructions with full market context. The agent decides the best route
 * and execution method.
 */
function buildPrompt(action: TradeAction, config: BotConfig): string {
  const market = action.market;

  switch (action.type) {
    case "rotate_to_stable": {
      const usdValue = (action.tokenAmount * market.price).toFixed(2);
      const priceFmt = market.price.toFixed(2);
      const changePart = market.priceChangePct !== 0
        ? `${config.riskAsset} ${market.priceChangePct > 0 ? "up" : "dropped"} ${Math.abs(market.priceChangePct).toFixed(2)}% recently, `
        : "";
      const maPart = `The ${config.fastMaPeriod}-tick MA ($${market.fastMA.toFixed(2)}) ${market.fastAboveSlow ? "is above" : "has crossed below"} the ${config.slowMaPeriod}-hour MA ($${market.slowMA.toFixed(2)}), spread ${market.maSpreadPct >= 0 ? "+" : ""}${market.maSpreadPct.toFixed(3)}%.`;
      const change24h = market.priceChange24hPct !== 0
        ? ` 24h change: ${market.priceChange24hPct >= 0 ? "+" : ""}${market.priceChange24hPct.toFixed(1)}%.`
        : "";

      return (
        `${changePart}currently at $${priceFmt}. ${maPart}${change24h} ` +
        `Swap ${action.tokenAmount.toFixed(4)} ${config.riskAsset} (~$${usdValue}) for ${config.stableAsset} on Ethereum mainnet. ` +
        `Find the best route — Uniswap, CoW Swap, or 1inch — keep slippage under ${config.maxSlippage}%.`
      );
    }

    case "rotate_to_risk": {
      const priceFmt = market.price.toFixed(2);
      const changePart = market.priceChangePct !== 0
        ? `${config.riskAsset} ${market.priceChangePct > 0 ? "rallied" : "moved"} ${Math.abs(market.priceChangePct).toFixed(2)}% recently, `
        : "";
      const maPart = `The ${config.fastMaPeriod}-tick MA ($${market.fastMA.toFixed(2)}) has crossed back above the ${config.slowMaPeriod}-hour MA ($${market.slowMA.toFixed(2)}), spread +${market.maSpreadPct.toFixed(3)}%.`;
      const change24h = market.priceChange24hPct !== 0
        ? ` 24h change: ${market.priceChange24hPct >= 0 ? "+" : ""}${market.priceChange24hPct.toFixed(1)}%.`
        : "";

      return (
        `${changePart}currently at $${priceFmt}. ${maPart}${change24h} ` +
        `Swap $${action.usdAmount.toFixed(2)} ${config.stableAsset} for ${config.riskAsset} on Ethereum mainnet. ` +
        `Find the best route — Uniswap, CoW Swap, or 1inch — keep slippage under ${config.maxSlippage}%.`
      );
    }

    case "emergency_exit": {
      return (
        `URGENT: ${action.reason} ` +
        `Sell ALL remaining ${config.riskAsset} for ${config.stableAsset} immediately on Ethereum mainnet. ` +
        `Use the fastest available route — Uniswap, CoW Swap, or 1inch. ` +
        `Slippage up to 2% is acceptable given urgency.`
      );
    }
  }
}
