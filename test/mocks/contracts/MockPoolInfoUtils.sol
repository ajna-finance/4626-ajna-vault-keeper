pragma solidity ^0.8.18;

import {MockVault} from './MockVault.sol';

contract MockPoolInfoUtils {
  MockVault _vault;

  uint256 public lupVal;
  uint256 public htpVal;

  mapping (address => AuctionStatus) public auctions;

  struct AuctionStatus {
    uint256 kickTime;
    uint256 collateral;
    uint256 debt;
    bool isCollateralized;
    uint256 price;
    uint256 neutralPrice;
    uint256 referencePrice;
    uint256 debtToCollateral;
    uint256 bondFactor;
  }

  constructor(address _mockVault) {
    _vault = MockVault(_mockVault);
  }

  function auctionStatus(address _poolAddress, address _borrower) public view returns (
    uint256,
    uint256,
    uint256,
    bool,
    uint256,
    uint256,
    uint256,
    uint256,
    uint256
  ) {
    return (
      auctions[_borrower].kickTime,
      auctions[_borrower].collateral,
      auctions[_borrower].debt,
      false,
      0,
      0,
      0,
      0,
      0
    );
  }

  function setAuctionStatus(address _borrower, uint256 _kickTime, uint256 _collateral, uint256 _debt) public {
    auctions[_borrower].kickTime = _kickTime;
    auctions[_borrower].collateral = _collateral;
    auctions[_borrower].debt = _debt;
  }

  function indexToPrice(uint256 _index) public view returns (uint256) {
    return _vault.indexToPrice(_index);
  }

  function priceToIndex(uint256 _price) public view returns (uint256) {
    return _vault.priceToIndex(_price);
  }

  function lpToQuoteTokens(address _pool, uint256 _lps, uint256 _index) public view returns (uint256) {
    return _vault.qts(_index);
  }

  function setLup(uint256 _price) public {
    lupVal = _price;
  }

  function setHtp(uint256 _price) public {
    htpVal = _price;
  }

  function lup(address _pool) public view returns (uint256) {
    return lupVal;
  }

  function htp(address _pool) public view returns (uint256) {
    return htpVal;
  }
}
