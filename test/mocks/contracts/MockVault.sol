pragma solidity ^0.8.18;

import {MockBuffer} from './MockBuffer.sol';
import {MockPoolInfoUtils} from './MockPoolInfoUtils.sol';

interface IMockVaultAuth {
    function paused() external view returns (bool);
}

interface IMockCollateralToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract MockVault {
    MockPoolInfoUtils private immutable INFO;
    MockBuffer private immutable BUFFER;
    address private immutable POOL;

    uint256[] public buckets;
    uint8 public assetDecimals;
    uint256 public totalAssets;

    address public AUTH;
    uint256 public removedCollateralValue;
    uint256 private _lpDust;
    address public collateralToken;

    mapping(uint256 => uint256) public indexToPrice;
    mapping(uint256 => uint256) public priceToIndex;
    mapping(uint256 => uint256) public qts;
    mapping(uint256 => uint256) public mockLpToValue;
    mapping(uint256 => uint256) public lps;
    mapping(uint256 => mapping(address => uint256)) public lenderLps;

    constructor(address _pool) {
        INFO = new MockPoolInfoUtils(address(this));
        BUFFER = new MockBuffer();
        POOL = _pool;

        assetDecimals = 18;
        _lpDust = 1;
    }

    function pool() public view returns (address) {
        return address(POOL);
    }

    function buffer() public view returns (address) {
        return address(BUFFER);
    }

    function info() public view returns (address) {
        return address(INFO);
    }

    function paused() public view returns (bool) {
        bool adminPaused = AUTH == address(0) ? false : IMockVaultAuth(AUTH).paused();
        return adminPaused || removedCollateralValue > 0;
    }

    function LP_DUST() public view returns (uint256) {
        return _lpDust;
    }

    function setAuth(address _auth) public {
        AUTH = _auth;
    }

    function setLpDust(uint256 _d) public {
        _lpDust = _d;
    }

    function setRemovedCollateralValue(uint256 _v) public {
        removedCollateralValue = _v;
    }

    function setCollateralToken(address _token) public {
        collateralToken = _token;
    }

    function setLenderLps(uint256 _bucket, address _lender, uint256 _lps) public {
        lenderLps[_bucket][_lender] = _lps;
    }

    function recoverCollateral(uint256[] memory _fromIndexes, uint256[] memory _amts) public {
        require(!_authPaused(), 'MockVault: admin paused');
        require(_fromIndexes.length == _amts.length, 'MockVault: length mismatch');
        uint256 total = 0;
        for (uint256 i = 0; i < _fromIndexes.length; i++) {
            total += _amts[i];
        }
        removedCollateralValue += total;
        if (collateralToken != address(0) && total > 0) {
            IMockCollateralToken(collateralToken).transfer(msg.sender, total);
        }
    }

    function returnQuoteToken(uint256 _toIndex, uint256 _amt) public {
        require(paused(), 'MockVault: not paused');
        if (qts[_toIndex] == 0) {
            require(_amt >= _lpDust, 'MockVault: below dust');
        }
        removedCollateralValue = 0;
        _addToBucket(_amt, _toIndex);
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
      return qts[_bucket];
    }

    function setLpToValue(uint256 _bucket, uint256 _amount) public {
      mockLpToValue[_bucket] = _amount;
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

    function _authPaused() internal view returns (bool) {
      if (AUTH == address(0)) return false;
      return IMockVaultAuth(AUTH).paused();
    }

    function drain(uint256 _index) public {}
}
