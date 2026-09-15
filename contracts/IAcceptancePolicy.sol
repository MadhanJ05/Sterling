// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Record} from "./Types.sol";

/// @notice A stateless, pure acceptance policy. The escrow holds no verdict logic of its own
///         and has no way to override what this returns.
interface IAcceptancePolicy {
    function policyId() external pure returns (bytes32);
    function policyVersion() external pure returns (uint16);
    function requiredRuleMask() external pure returns (uint8);

    /// @return verdict  0 = INDETERMINATE, 1 = PASS, 2 = FAIL
    /// @return ruleId   1..4 for a FAIL, 0 otherwise
    /// @return failCode see FailCode library
    /// @return detailA  productId or row count involved
    /// @return detailB  secondary value (expected price, occurrence count, previous id)
    function evaluate(
        Record[] calldata source,
        Record[] calldata output,
        uint16 requiredRowCount,
        uint8 ruleMask
    ) external pure returns (uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB);
}
