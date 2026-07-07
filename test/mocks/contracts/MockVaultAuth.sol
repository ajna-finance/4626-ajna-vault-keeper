pragma solidity ^0.8.18;

contract MockVaultAuth {
  uint256 public minBucketIndex = 4155;
  uint256 public bufferRatio;
  bool public paused;
  address public swapper;

  function setBufferRatio(uint256 _ratio) public {
    bufferRatio = _ratio;
  }

  function setMinBucketIndex(uint256 _index) public {
    minBucketIndex = _index;
  }

  function setAuthPaused(bool _status) public {
    paused = _status;
  }

  function setSwapper(address _swapper) public {
    swapper = _swapper;
  }
}
