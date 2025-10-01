pragma solidity ^0.8.18;

import {Script} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Vault} from "../../lib/4626-ajna-vault/src/Vault.sol";
import {VaultAuth} from "../../lib/4626-ajna-vault/src/VaultAuth.sol";
import {MockVault} from "../mocks/contracts/MockVault.sol";
import {MockVaultAuth} from "../mocks/contracts/MockVaultAuth.sol";
import {MockChronicle} from "../mocks/contracts/MockChronicle.sol";
import {MockPool} from "../mocks/contracts/MockPool.sol";
import {IPool} from "ajna-core/interfaces/pool/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployScript is Script, StdCheats {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address mockVaultAddress;
        address mockVaultAuthAddress;
        address mockChronicleAddress;   
        address mockPoolAddress; 

        vm.startBroadcast(deployerPrivateKey);
        mockPoolAddress = address(new MockPool());
        mockVaultAddress = address(new MockVault(mockPoolAddress));
        mockVaultAuthAddress = address(new MockVaultAuth());
        mockChronicleAddress = address(new MockChronicle());
        vm.stopBroadcast();

        string memory addresses = string.concat(
            "VAULT_ADDRESS=", vm.toString(address(0)), "\n"
            "VAULT_AUTH_ADDRESS=", vm.toString(address(0)), "\n"
            "MOCK_VAULT_ADDRESS=", vm.toString(mockVaultAddress), "\n"
            "MOCK_VAULT_AUTH_ADDRESS=", vm.toString(mockVaultAuthAddress), "\n"
            "MOCK_CHRONICLE_ADDRESS=", vm.toString(mockChronicleAddress), "\n"
        );

        vm.writeFile("test/script/test-addresses.env", addresses);
    }
}
