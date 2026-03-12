/**
 * EVM Transaction Signer
 *
 * Handles signing and broadcasting transactions from InlineCall payloads
 * using a local private key via viem.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mainnet, arbitrum, optimism, base, polygon } from "viem/chains";

export interface Signer {
  account: PrivateKeyAccount;
  wallet: WalletClient;
  publicClient: PublicClient;
  address: Hex;
}

/** Resolve a chain object from chain ID. */
function resolveChain(chainId: number): Chain {
  const chains: Record<number, Chain> = {
    1: mainnet,
    42161: arbitrum,
    10: optimism,
    8453: base,
    137: polygon,
  };
  const chain = chains[chainId];
  if (!chain) {
    // Fallback: construct a minimal chain config
    return {
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [] } },
    } as Chain;
  }
  return chain;
}

/** Create a signer from a private key and RPC URL. */
export function createSigner(privateKey: Hex, rpcUrl: string, chainId: number): Signer {
  const account = privateKeyToAccount(privateKey);
  const chain = resolveChain(chainId);

  const wallet = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  return {
    account,
    wallet,
    publicClient,
    address: account.address,
  };
}

/**
 * Expected shape of the InlineCall payload for wallet_tx_request.
 * The Aomi agent sends an unsigned transaction in this format.
 */
export interface TxPayload {
  to: Hex;
  value?: string; // wei as decimal string or hex
  data?: Hex;
  chainId?: number;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
}

/** Parse an InlineCall payload into a TxPayload. */
export function parseTxPayload(payload: unknown): TxPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid tx payload: expected an object");
  }
  const p = payload as Record<string, unknown>;

  // Handle nested { tx: { ... } } or flat { to, value, data, ... }
  const tx = (p.tx && typeof p.tx === "object" ? p.tx : p) as Record<string, unknown>;

  if (!tx.to || typeof tx.to !== "string") {
    throw new Error("Invalid tx payload: missing 'to' address");
  }

  return {
    to: tx.to as Hex,
    value: tx.value != null ? String(tx.value) : undefined,
    data: tx.data as Hex | undefined,
    chainId: tx.chainId != null ? Number(tx.chainId) : undefined,
    gas: tx.gas != null ? String(tx.gas) : undefined,
    gasPrice: tx.gasPrice != null ? String(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas != null ? String(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas != null ? String(tx.maxPriorityFeePerGas) : undefined,
    nonce: tx.nonce != null ? Number(tx.nonce) : undefined,
  };
}

/** Sign and broadcast a transaction. Returns the tx hash. */
export async function sendTransaction(signer: Signer, payload: TxPayload): Promise<Hex> {
  const hash = await signer.wallet.sendTransaction({
    to: payload.to,
    data: payload.data,
    value: payload.value ? BigInt(payload.value) : undefined,
    gas: payload.gas ? BigInt(payload.gas) : undefined,
    maxFeePerGas: payload.maxFeePerGas ? BigInt(payload.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: payload.maxPriorityFeePerGas ? BigInt(payload.maxPriorityFeePerGas) : undefined,
    nonce: payload.nonce,
    chain: signer.wallet.chain,
    account: signer.account,
  });
  console.log(`[signer] Transaction sent: ${hash}`);
  return hash;
}

/** Wait for a transaction receipt. */
export async function waitForReceipt(signer: Signer, hash: Hex) {
  const receipt = await signer.publicClient.waitForTransactionReceipt({ hash });
  console.log(`[signer] Transaction confirmed: ${hash} (block ${receipt.blockNumber}, status: ${receipt.status})`);
  return receipt;
}
