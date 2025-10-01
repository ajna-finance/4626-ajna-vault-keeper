pragma solidity ^0.8.18;

contract MockVaultAuth {
  uint256 public minBucketIndex = 4155;
  uint256 public bufferRatio;

  function setBufferRatio(uint256 _ratio) public {
    bufferRatio = _ratio;
  }
}
