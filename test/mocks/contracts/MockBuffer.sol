pragma solidity ^0.8.18;

contract MockBuffer {
    uint256 public total;

    function addToBuffer(uint256 amount) public {
        total += amount;
    }

    function removeFromBuffer(uint256 amount) public {
        total -= amount;
    }
}
