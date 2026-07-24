pragma solidity ^0.8.18;

contract MockPool {
    uint256 public bankruptcyTime;
    uint256 lps;
    address[] public auctionBorrowers;

    function setAuctionBorrowers(address[] memory _borrowers) public {
        auctionBorrowers = _borrowers;
    }

    function totalAuctionsInPool() public view returns (uint256) {
        return auctionBorrowers.length;
    }

    function auctionInfo(address _borrower) public view returns (
        address, uint256, uint256, uint256, uint256, uint256, uint256, address, address, address
    ) {
        address head = auctionBorrowers.length > 0 ? auctionBorrowers[0] : address(0);
        address next;
        uint256 kickTime;
        for (uint256 i = 0; i < auctionBorrowers.length; i++) {
            if (auctionBorrowers[i] == _borrower) {
                kickTime = 1;
                if (i + 1 < auctionBorrowers.length) next = auctionBorrowers[i + 1];
            }
        }
        return (address(0), 0, 0, kickTime, 0, 0, 0, head, next, address(0));
    }

    function reservesInfo() public pure returns (uint256, uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 0, 0);
    }

    function lenderInfo(uint256, address) public view returns (uint256, uint256) {
        return (lps, 0);
    }

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

    function totalT0DebtInAuction() public returns (uint256) {
        return 0;
    }

    function inflatorInfo() public returns (uint256, uint256) {
        return (0, 0);
    }

    function depositIndex(uint256 _index) public returns (uint256) {
        return 0;
    }
}
