// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice TEST ONLY. Credits the escrow in full on `transferFrom` but skims 10% on the way out.
///         An earlier escrow checked only how much left its own balance, not how much arrived, so
///         a job reached PAID with the supplier short-changed. Reproduced by the independent
///         review of 14 September 2026 and now asserted against in tests/regression-rereview.test.ts.
contract OutgoingFeeToken {
    string public constant name = "Outgoing Fee Test Token";
    string public constant symbol = "FEE";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

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

    /// @dev Inbound is honest: the full amount arrives.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev Outbound skims 10%. The sender is debited in full; the recipient is credited less.
    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 fee = amount / 10;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        emit Transfer(msg.sender, to, amount - fee);
        return true;
    }
}
