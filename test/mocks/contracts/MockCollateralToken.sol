pragma solidity ^0.8.18;

// Minimal mintable ERC20 standing in for the pool's collateral token in integration
// tests. Implements exactly the surface the recovery keeper touches: balanceOf and
// decimals reads, transfer (MockVault.recoverCollateral pays the caller with it),
// and the approve/allowance pair approveExact uses before handing collateral to the
// swap adapter's spender.
contract MockCollateralToken {
    string public name = 'Mock Collateral';
    string public symbol = 'MCOL';
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function mint(address _to, uint256 _amount) public {
        balanceOf[_to] += _amount;
        totalSupply += _amount;
        emit Transfer(address(0), _to, _amount);
    }

    function approve(address _spender, uint256 _amount) public returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        emit Approval(msg.sender, _spender, _amount);
        return true;
    }

    function transfer(address _to, uint256 _amount) public returns (bool) {
        return _move(msg.sender, _to, _amount);
    }

    function transferFrom(address _from, address _to, uint256 _amount) public returns (bool) {
        uint256 allowed = allowance[_from][msg.sender];
        require(allowed >= _amount, 'MockCollateralToken: insufficient allowance');
        if (allowed != type(uint256).max) {
            allowance[_from][msg.sender] = allowed - _amount;
        }
        return _move(_from, _to, _amount);
    }

    function _move(address _from, address _to, uint256 _amount) internal returns (bool) {
        require(balanceOf[_from] >= _amount, 'MockCollateralToken: insufficient balance');
        balanceOf[_from] -= _amount;
        balanceOf[_to] += _amount;
        emit Transfer(_from, _to, _amount);
        return true;
    }
}
