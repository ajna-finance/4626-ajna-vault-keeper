export const mockChronicleAbi = [
  {
    type: 'function',
    name: 'setPrice',
    inputs: [{ name: 'price', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setAge',
    inputs: [{ name: 'timestamp', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'readWithAge',
    inputs: [],
    outputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
] as const;
