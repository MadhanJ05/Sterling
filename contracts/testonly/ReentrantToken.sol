// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IEscrowReentry {
    function settle(uint256 jobId) external;
    function refundExpired(uint256 jobId) external;
}

/// @notice TEST ONLY. An ERC-20 that calls back into the escrow during `transfer`, to prove the
///         escrow's reentrancy guard and checks-effects-interactions ordering hold.
contract ReentrantToken {
    string public constant name = "Reentrant Test Token";
    string public constant symbol = "rTT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    uint256 public targetJobId;
    uint8 public mode; // 0 = off, 1 = re-enter settle, 2 = re-enter refundExpired
    bool public reentryAttempted;
    bool public reentrySucceeded;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function arm(address target_, uint256 jobId_, uint8 mode_) external {
        target = target_;
        targetJobId = jobId_;
        mode = mode_;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        _maybeReenter();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        _maybeReenter();
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _maybeReenter() internal {
        if (mode == 0 || target == address(0)) return;
        reentryAttempted = true;
        if (mode == 1) {
            try IEscrowReentry(target).settle(targetJobId) { reentrySucceeded = true; } catch {}
        } else {
            try IEscrowReentry(target).refundExpired(targetJobId) { reentrySucceeded = true; } catch {}
        }
    }
}
