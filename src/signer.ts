/**
 * EVM Transaction & EIP-712 Signer
 *
 * Handles signing and broadcasting transactions using a local private key
 * via viem. Also supports EIP-712 typed data signing for CoW Protocol
 * gasless swaps and permits.
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
import type { WalletTxPayload, WalletEip712Payload } from "@aomi-labs/client";

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

/** Sign EIP-712 typed data (for CoW Protocol gasless swaps, permits, etc.). Returns the signature. */
export async function signEip712(signer: Signer, payload: WalletEip712Payload): Promise<Hex> {
  const typedData = payload.typed_data;
  if (!typedData) throw new Error("EIP-712 payload missing typed_data");

  // Filter out EIP712Domain from types (viem adds it automatically)
  const types = { ...typedData.types };
  delete (types as Record<string, unknown>)["EIP712Domain"];

  const signature = await signer.wallet.signTypedData({
    account: signer.account,
    domain: typedData.domain as Record<string, unknown>,
    types,
    primaryType: typedData.primaryType ?? "",
    message: typedData.message ?? {},
  });

  console.log(`[signer] EIP-712 signed: ${signature.slice(0, 20)}...`);
  return signature;
}
