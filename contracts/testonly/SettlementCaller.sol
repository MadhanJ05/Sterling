// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice TEST ONLY. A third party contract that calls settle, proving that "anyone may request
///         settlement" does not let the requester choose the outcome.
contract SettlementCaller {
    function callSettle(address escrow, uint256 jobId) external {
        (bool ok, bytes memory data) = escrow.call(abi.encodeWithSignature("settle(uint256)", jobId));
        if (!ok) {
            assembly { revert(add(data, 32), mload(data)) }
        }
    }
}
