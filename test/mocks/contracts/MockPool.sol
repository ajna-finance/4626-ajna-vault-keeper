pragma solidity ^0.8.18;

contract MockPool {
    uint256 public bankruptcyTime;

    function bucketInfo(uint256 _index) public view returns (uint256, uint256, uint256, uint256, uint256) {
        return (
            0,
            0,
            bankruptcyTime,
            0,
            0
        );
    }

    function setBankruptcyTime(uint256 _timestamp) public {
        bankruptcyTime = _timestamp;
    }

    function updateInterest() public {}
}
