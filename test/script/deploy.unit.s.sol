pragma solidity ^0.8.18;

import {Script} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Vault} from "../../lib/4626-ajna-vault/src/Vault.sol";
import {VaultAuth} from "../../lib/4626-ajna-vault/src/VaultAuth.sol";
import {MockVault} from "../mocks/contracts/MockVault.sol";
import {MockVaultAuth} from "../mocks/contracts/MockVaultAuth.sol";
import {MockChronicle} from "../mocks/contracts/MockChronicle.sol";
import {IPool} from "ajna-core/interfaces/pool/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployScript is Script, StdCheats {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);
        address sUSDeDaiPoolAddress = 0x34bC3D3d274A355f3404c5dEe2a96335540234de;
        address mockVaultAddress;
        address mockVaultAuthAddress;
        address mockChronicleAddress;
        
        IPool pool = IPool(sUSDeDaiPoolAddress);
        Vault vault;
        VaultAuth vaultAuth;

        vm.startBroadcast(deployerPrivateKey);
        vaultAuth = new VaultAuth();
        vault = new Vault(
            pool,
            0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE,
            IERC20(pool.quoteTokenAddress()),
            "test",
            "TEST",
            vaultAuth
        );

        mockVaultAddress = address(new MockVault(address(0)));
        mockVaultAuthAddress = address(new MockVaultAuth());
        mockChronicleAddress = address(new MockChronicle());

        vaultAuth.setBufferRatio(5000);
        vaultAuth.setKeeper(deployerAddress, true);

        IERC20(vault.asset()).approve(address(vault), type(uint256).max);
        vault.deposit(100 * (10 ** 18), deployerAddress);
        vm.stopBroadcast();

        string memory addresses = string.concat(
            "VAULT_ADDRESS=", vm.toString(address(vault)), "\n"
            "VAULT_AUTH_ADDRESS=", vm.toString(address(vaultAuth)), "\n"
            "MOCK_VAULT_ADDRESS=", vm.toString(mockVaultAddress), "\n"
            "MOCK_VAULT_AUTH_ADDRESS=", vm.toString(mockVaultAuthAddress), "\n"
            "MOCK_CHRONICLE_ADDRESS=", vm.toString(mockChronicleAddress), "\n"
        );

        vm.writeFile("test/script/test-addresses.env", addresses);
    }
}
