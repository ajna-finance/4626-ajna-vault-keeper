export const chronicleAbi = [
  {
    name: 'readWithAge',
    stateMutability: 'view',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
] as const;
