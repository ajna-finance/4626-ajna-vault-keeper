pragma solidity ^0.8.18;

import {Script} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Vault} from "../../lib/4626-ajna-vault/src/Vault.sol";
import {VaultAuth} from "../../lib/4626-ajna-vault/src/VaultAuth.sol";
import {MockVault} from "../mocks/contracts/MockVault.sol";
import {MockVaultAuth} from "../mocks/contracts/MockVaultAuth.sol";
import {MockChronicle} from "../mocks/contracts/MockChronicle.sol";
import {MockCollateralToken} from "../mocks/contracts/MockCollateralToken.sol";
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
        address mockCollateralTokenAddress;

        vm.startBroadcast(deployerPrivateKey);
        mockPoolAddress = address(new MockPool());
        mockVaultAddress = address(new MockVault(mockPoolAddress));
        mockVaultAuthAddress = address(new MockVaultAuth());
        mockChronicleAddress = address(new MockChronicle());
        MockVault(mockVaultAddress).setAuth(mockVaultAuthAddress);

        // Collateral token for the recovery-path tests. Deploy-only: wiring it into
        // the pool/vault and minting happen PER-TEST in the recovery suite, inside
        // the fork-snapshot scope. This script is shared with the arkKeeper
        // integration suite, which showed intermittent anvil snapshot/timeout
        // instability during development that correlated with extra deploy-time
        // transactions — keep this script inert beyond the deploy itself and do
        // recovery-specific state setup in the recovery tests.
        mockCollateralTokenAddress = address(new MockCollateralToken(18));
        vm.stopBroadcast();

        string memory addresses = string.concat(
            "VAULT_ADDRESS=", vm.toString(address(0)), "\n"
            "VAULT_AUTH_ADDRESS=", vm.toString(address(0)), "\n"
            "MOCK_VAULT_ADDRESS=", vm.toString(mockVaultAddress), "\n"
            "MOCK_VAULT_AUTH_ADDRESS=", vm.toString(mockVaultAuthAddress), "\n"
            "MOCK_CHRONICLE_ADDRESS=", vm.toString(mockChronicleAddress), "\n"
            "MOCK_COLLATERAL_TOKEN_ADDRESS=", vm.toString(mockCollateralTokenAddress), "\n"
        );

        vm.writeFile("test/script/test-addresses.env", addresses);
    }
}
