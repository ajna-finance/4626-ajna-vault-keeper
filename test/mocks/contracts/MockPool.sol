pragma solidity ^0.8.18;

contract MockPool {
    uint256 public bankruptcyTime;
    uint256 lps;

    function bucketInfo(uint256 _index) public view returns (uint256, uint256, uint256, uint256, uint256) {
        return (
            lps,
            0,
            bankruptcyTime,
            0,
            0
        );
    }

    function setBankruptcyTime(uint256 _timestamp) public {
        bankruptcyTime = _timestamp;
    }

    function setLps(uint256 _lps) public {
        lps = _lps;
    }

    function updateInterest() public {}
}
