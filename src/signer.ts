/**
 * EVM Transaction Signer
 *
 * Handles signing and broadcasting transactions using a local private key
 * via viem. Accepts WalletTxPayload from @aomi-labs/client directly.
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
import type { WalletTxPayload } from "@aomi-labs/client";

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

/** Sign and broadcast a transaction from a WalletTxPayload. Returns the tx hash. */
export async function sendTransaction(signer: Signer, payload: WalletTxPayload): Promise<Hex> {
  const hash = await signer.wallet.sendTransaction({
    to: payload.to as Hex,
    data: payload.data as Hex | undefined,
    value: payload.value ? BigInt(payload.value) : undefined,
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
