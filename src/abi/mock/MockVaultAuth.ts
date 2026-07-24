export const mockVaultAuthAbi = [
  {
    type: 'function',
    name: 'bufferRatio',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'minBucketIndex',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setBufferRatio',
    inputs: [{ name: '_ratio', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
