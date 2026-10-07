// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BusinessPolicyVault {
    address public immutable owner;
    IERC20 public immutable token;

    uint256 public maxTransaction;
    uint256 public dailyLimit;
    uint256 public cashFloor;

    uint256 public dailySpent;
    uint256 public dayStart;
    bool public paused;

    mapping(bytes32 => address) public vendorRecipient;
    mapping(bytes32 => bool) public usedPayment;

    event PolicyUpdated(uint256 maxTransaction, uint256 dailyLimit, uint256 cashFloor);
    event VendorSet(bytes32 indexed vendorId, address indexed recipient);
    event Paused(bool paused);
    event PaymentExecuted(
        bytes32 indexed paymentId,
        bytes32 indexed vendorId,
        address indexed recipient,
        uint256 amount,
        bytes32 invoiceHash
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        address owner_,
        address token_,
        uint256 maxTransaction_,
        uint256 dailyLimit_,
        uint256 cashFloor_
    ) {
        require(owner_ != address(0), "OWNER_ZERO");
        require(token_ != address(0), "TOKEN_ZERO");
        require(maxTransaction_ > 0, "MAX_TX_ZERO");
        require(dailyLimit_ >= maxTransaction_, "MAX_GT_DAILY");

        owner = owner_;
        token = IERC20(token_);
        maxTransaction = maxTransaction_;
        dailyLimit = dailyLimit_;
        cashFloor = cashFloor_;
        dayStart = block.timestamp - (block.timestamp % 1 days);
    }

    function setPolicy(
        uint256 maxTransaction_,
        uint256 dailyLimit_,
        uint256 cashFloor_
    ) external onlyOwner {
        require(maxTransaction_ > 0, "MAX_TX_ZERO");
        require(dailyLimit_ >= maxTransaction_, "MAX_GT_DAILY");

        maxTransaction = maxTransaction_;
        dailyLimit = dailyLimit_;
        cashFloor = cashFloor_;

        emit PolicyUpdated(maxTransaction_, dailyLimit_, cashFloor_);
    }

    function setVendor(bytes32 vendorId, address recipient) external onlyOwner {
        vendorRecipient[vendorId] = recipient;
        emit VendorSet(vendorId, recipient);
    }

    function vendorRevocationSupported() external pure returns (bool) {
        return true;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    function currentDaySpent() public view returns (uint256) {
        if (block.timestamp >= dayStart + 1 days) return 0;
        return dailySpent;
    }

    function vaultBalance() public view returns (uint256) {
        return token.balanceOf(owner);
    }

    function availableToSpend() public view returns (uint256) {
        uint256 balance = token.balanceOf(owner);
        if (balance <= cashFloor) return 0;
        return balance - cashFloor;
    }

    function canExecute(
        bytes32 paymentId,
        bytes32 vendorId,
        uint256 amount
    ) public view returns (bool allowed, string memory reason) {
        if (paused) return (false, "PAUSED");
        if (usedPayment[paymentId]) return (false, "DUPLICATE_PAYMENT");
        if (amount == 0) return (false, "ZERO_AMOUNT");
        if (amount > maxTransaction) return (false, "MAX_TRANSACTION");
        if (vendorRecipient[vendorId] == address(0)) return (false, "VENDOR_NOT_ALLOWED");

        uint256 spent = currentDaySpent();
        if (spent + amount > dailyLimit) return (false, "DAILY_LIMIT");

        uint256 balance = token.balanceOf(owner);
        if (balance < amount + cashFloor) return (false, "CASH_FLOOR");
        if (token.allowance(owner, address(this)) < amount) return (false, "ALLOWANCE");

        return (true, "ALLOWED");
    }

    function executePayment(
        bytes32 paymentId,
        bytes32 vendorId,
        uint256 amount,
        bytes32 invoiceHash
    ) external onlyOwner {
        (bool allowed, string memory reason) = canExecute(paymentId, vendorId, amount);
        require(allowed, reason);

        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp - (block.timestamp % 1 days);
            dailySpent = 0;
        }

        address recipient = vendorRecipient[vendorId];
        usedPayment[paymentId] = true;
        dailySpent += amount;

        require(token.transferFrom(owner, recipient, amount), "TRANSFER_FAILED");

        emit PaymentExecuted(paymentId, vendorId, recipient, amount, invoiceHash);
    }

}
