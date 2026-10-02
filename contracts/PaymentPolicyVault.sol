// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract PaymentPolicyVault {
    address public immutable owner;
    address public immutable executor;
    address public immutable usdc;

    uint256 public txLimit;
    uint256 public dailyLimit;
    uint256 public dailySpent;
    uint256 public dayStart;
    uint256 public cashFloor;
    bool public paused;

    mapping(bytes32 => address) public vendorRecipient;
    mapping(bytes32 => bool) public usedPayment;

    event VendorSet(bytes32 indexed vendorId, address indexed recipient);
    event PolicySet(uint256 txLimit, uint256 dailyLimit, uint256 cashFloor);
    event Paused();
    event Unpaused();
    event PaymentExecuted(
        bytes32 indexed paymentId,
        bytes32 indexed vendorId,
        address indexed recipient,        uint256 amount,
        bytes32 invoiceHash
    );

    error NotOwner();
    error NotExecutor();
    error VaultPaused();
    error InvalidAmount();
    error UnknownVendor();
    error DuplicatePayment();
    error DailyLimitExceeded();
    error CashFloorViolation();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(
        address _usdc,
        uint256 _txLimit,
        uint256 _dailyLimit,
        uint256 _cashFloor
    ) {
        owner = msg.sender;
        executor = msg.sender;
        usdc = _usdc;
        txLimit = _txLimit;
        dailyLimit = _dailyLimit;
        cashFloor = _cashFloor;
        dayStart = block.timestamp;
        emit PolicySet(_txLimit, _dailyLimit, _cashFloor);
    }

    function setVendor(bytes32 vendorId, address recipient) external onlyOwner {
        require(recipient != address(0), "recipient=0");
        vendorRecipient[vendorId] = recipient;
        emit VendorSet(vendorId, recipient);
    }

    function setPolicy(
        uint256 _txLimit,
        uint256 _dailyLimit,
        uint256 _cashFloor
    ) external onlyOwner {        txLimit = _txLimit;
        dailyLimit = _dailyLimit;
        cashFloor = _cashFloor;
        emit PolicySet(_txLimit, _dailyLimit, _cashFloor);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function executePayment(
        bytes32 paymentId,
        bytes32 vendorId,
        uint256 amount,
        bytes32 invoiceHash
    ) external onlyExecutor {
        if (paused) revert VaultPaused();
        if (amount == 0 || amount > txLimit) revert InvalidAmount();

        address recipient = vendorRecipient[vendorId];
        if (recipient == address(0)) revert UnknownVendor();
        if (usedPayment[paymentId]) revert DuplicatePayment();

        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            dailySpent = 0;
        }
        if (dailySpent + amount > dailyLimit) revert DailyLimitExceeded();

        uint256 balance = IERC20Minimal(usdc).balanceOf(address(this));
        if (balance < amount + cashFloor) revert CashFloorViolation();

        usedPayment[paymentId] = true;
        dailySpent += amount;

        if (!IERC20Minimal(usdc).transfer(recipient, amount)) {
            revert TransferFailed();
        }

        emit PaymentExecuted(paymentId, vendorId, recipient, amount, invoiceHash);
    }    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
    }

    function currentPolicy()
        external
        view
        returns (
            uint256 currentTxLimit,
            uint256 currentDailyLimit,
            uint256 currentDailySpent,
            uint256 currentCashFloor,
            uint256 currentBalance,
            bool isPaused
        )
    {
        currentBalance = IERC20Minimal(usdc).balanceOf(address(this));
        return (
            txLimit,
            dailyLimit,
            dailySpent,
            cashFloor,
            currentBalance,
            paused
        );
    }
}
