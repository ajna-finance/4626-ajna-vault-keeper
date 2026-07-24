pragma solidity 0.8.18;

import {Script} from 'forge-std/Script.sol';
import {Vault} from '../../lib/4626-ajna-vault/src/Vault.sol';
import {VaultAuth} from '../../lib/4626-ajna-vault/src/VaultAuth.sol';
import {IPool} from 'ajna-core/interfaces/pool/IPool.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint('PRIVATE_KEY');
        address deployerAddress = vm.addr(deployerPrivateKey);
        address sUSDeDaiPoolAddress = 0x34bC3D3d274A355f3404c5dEe2a96335540234de;
        IPool pool = IPool(sUSDeDaiPoolAddress);
        Vault ark1;
        Vault ark2;
        Vault ark3;
        VaultAuth arkAuth1;
        VaultAuth arkAuth2;
        VaultAuth arkAuth3;

        vm.startBroadcast(deployerPrivateKey);

        arkAuth1 = new VaultAuth();
        ark1 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            'test',
            'TEST',
            arkAuth1
        );

        arkAuth2 = new VaultAuth();
        ark2 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            'test',
            'TEST',
            arkAuth2
        );

        arkAuth3 = new VaultAuth();
        ark3 = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            'test',
            'TEST',
            arkAuth3
        );

        arkAuth1.setKeeper(deployerAddress, true);
        arkAuth2.setKeeper(deployerAddress, true);
        arkAuth3.setKeeper(deployerAddress, true);

        vm.stopBroadcast();

        string memory addresses = string.concat(
            'ARK_1_ADDRESS=',
            vm.toString(address(ark1)),
            '\n'
            'ARK_2_ADDRESS=',
            vm.toString(address(ark2)),
            '\n'
            'ARK_3_ADDRESS=',
            vm.toString(address(ark3)),
            '\n'
            'ARK_AUTH_1_ADDRESS=',
            vm.toString(address(arkAuth1)),
            '\n'
            'ARK_AUTH_2_ADDRESS=',
            vm.toString(address(arkAuth2)),
            '\n'
            'ARK_AUTH_3_ADDRESS=',
            vm.toString(address(arkAuth3)),
            '\n'
        );

        vm.writeFile('test/script/test-addresses.env', addresses);
    }
}
