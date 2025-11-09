import { describe, it, expect } from 'vitest';
import { _getUnsettledAuctions, _filterAuctions } from '../../src/subgraph/poolHealth';

describe('subgraph query', () => {
  it('can query subgraph for unsettled auctions', async () => {
    const result = await _getUnsettledAuctions();

    expect(result).toHaveProperty('liquidationAuctions');
  });

  it('can filter out auctions newer than the minAge', () => {
    const mockResponse = {
      liquidationAuctions: [
        {
          borrower: '0x',
          kickTime: '1725922914',
        },
        {
          borrower: '0x',
          kickTime: '1725922914',
        },
        {
          borrower: '0x',
          kickTime: String(Math.floor(Date.now() / 1000)),
        },
      ],
    };

    const filteredAuctions = _filterAuctions(mockResponse);
    expect(filteredAuctions.length).toBe(2);
    expect(filteredAuctions[0]?.kickTime).toBe('1725922914');
    expect(filteredAuctions[1]?.kickTime).toBe('1725922914');
  });
});
