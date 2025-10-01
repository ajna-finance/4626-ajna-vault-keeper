pragma solidity ^0.8.18;

contract MockChronicle {
  uint256 _price = 1000000000000000000;
  uint256 _age = block.timestamp;

  function setPrice(uint256 price) public {
    _price = price;
  }

  function setAge(uint256 timestamp) public {
    _age = timestamp;
  }

  function readWithAge() public view returns (uint256, uint256) {
    return (_price, _age);
  }
}
