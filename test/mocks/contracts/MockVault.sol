pragma solidity ^0.8.18;

import {MockBuffer} from './MockBuffer.sol';
import {MockPoolInfoUtils} from './MockPoolInfoUtils.sol';

contract MockVault {
    MockPoolInfoUtils public immutable INFO;
    MockBuffer public immutable BUFFER;
    address public immutable POOL;

    uint256[] public buckets;
    uint8 public assetDecimals;
    uint256 public totalAssets;
    bool public paused;

    mapping (uint256 => uint256) public indexToPrice;
    mapping (uint256 => uint256) public priceToIndex;
    mapping (uint256 => uint256) public qts; // index to qt value
    mapping (uint256 => uint256) public mockLpToValue; // fake mapping to test dusty buckets

    constructor(address _pool) {
        INFO = new MockPoolInfoUtils(address(this));
        BUFFER = new MockBuffer();
        POOL = _pool;

        assetDecimals = 18;
    }

    function move(uint256 _fromBucket, uint256 _toBucket, uint256 _amount) public {
        _removeFromBucket(_amount, _fromBucket);
        _addToBucket(_amount, _toBucket);
    }

    function moveToBuffer(uint256 _fromBucket, uint256 _amount) public {
        _removeFromBucket(_amount, _fromBucket);
        BUFFER.addToBuffer(_amount);
    }

    function moveFromBuffer(uint256 _toBucket, uint256 _amount) public {
        BUFFER.removeFromBuffer(_amount);
        _addToBucket(_amount, _toBucket);
    }

    function setAssetDecimals(uint8 _decimals) public {
        assetDecimals = _decimals;
    }

    function addBucket(uint256 _index, uint256 _price, uint256 _tokens) public {
        buckets.push(_index);
        _setBucketPrice(_price, _index);
        _addToBucket(_tokens, _index);
        totalAssets += _tokens;
    }

    function getBuckets() public view returns (uint256[] memory) {
        return buckets;
    }

    function lpToValuesSeparately(uint256 _bucket) public returns (uint256, uint256, uint256, uint256) {
      return (
        qts[_bucket],
        0,
        0,
        0
      );
    }

    function lpToValue(uint256 _bucket) public view returns (uint256) {
      return mockLpToValue[_bucket];
    }

    function setLpToValue(uint256 _bucket, uint256 _amount) public {
      mockLpToValue[_bucket] = _amount;
    }

    function setPaused(bool _status) public {
      paused = _status;
    }

    function _addToBucket(uint256 _amount, uint256 _index) internal {
      qts[_index] += _amount;
    }

    function _removeFromBucket(uint256 _amount, uint256 _index) internal {
      qts[_index] -= _amount;
    }

    function _setBucketPrice(uint256 _price, uint256 _index) internal {
      indexToPrice[_index] = _price;
      priceToIndex[_price] = _index;
    }

    function drain(uint256 _index) public {}
}
