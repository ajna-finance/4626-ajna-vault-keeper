// Names of the compiled-in swap adapters. This module must stay dependency-free:
// config validation imports it to reject unknown adapter names at load time, and
// config.ts sits below everything else in the import graph.
export const KNOWN_SWAP_ADAPTERS = ['cow'] as const;

export type SwapAdapterName = (typeof KNOWN_SWAP_ADAPTERS)[number];
