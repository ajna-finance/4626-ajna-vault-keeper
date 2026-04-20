pragma solidity ^0.8.18;

contract MockPool {
    uint256 public bankruptcyTime;
    uint256 lps;
    address public collateralAddress;

    mapping(uint256 => mapping(address => uint256)) private _lpBalances;

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

    function setCollateralAddress(address _addr) public {
        collateralAddress = _addr;
    }

    function setLenderLps(uint256 _index, address _lender, uint256 _lps) public {
        _lpBalances[_index][_lender] = _lps;
    }

    function lenderInfo(uint256 _index, address _lender) public view returns (uint256, uint256) {
        return (_lpBalances[_index][_lender], 0);
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
