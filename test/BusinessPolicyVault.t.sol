// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../contracts/BusinessPolicyVault.sol";

contract MockUsdc {
    function balanceOf(address) external pure returns (uint256) {
        return 1_000_000_000;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

contract BusinessPolicyVaultTest {
    function testVendorCanBeRevoked() external {
        MockUsdc token = new MockUsdc();
        BusinessPolicyVault vault = new BusinessPolicyVault(
            address(this),
            address(token),
            1_000_000,
            5_000_000,
            20_000
        );
        bytes32 vendorId = keccak256("vendor:acme");
        address recipient = address(0x1234);

        vault.setVendor(vendorId, recipient);
        require(vault.vendorRecipient(vendorId) == recipient, "VENDOR_NOT_REGISTERED");
        require(vault.vendorRevocationSupported(), "REVOCATION_CAPABILITY_MISSING");

        vault.setVendor(vendorId, address(0));
        require(vault.vendorRecipient(vendorId) == address(0), "VENDOR_NOT_REVOKED");
        (bool allowed, string memory reason) = vault.canExecute(
            keccak256("payment-1"),
            vendorId,
            100_000
        );
        require(!allowed, "REVOKED_VENDOR_ALLOWED");
        require(keccak256(bytes(reason)) == keccak256(bytes("VENDOR_NOT_ALLOWED")), "WRONG_BLOCK_REASON");
    }
}
