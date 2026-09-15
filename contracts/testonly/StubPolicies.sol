// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Record, Verdict, FailCode} from "../Types.sol";
import {IAcceptancePolicy} from "../IAcceptancePolicy.sol";

/// @notice TEST ONLY. Always INDETERMINATE, used to prove the escrow leaves such a job pending
///         and offers no admin override.
contract IndeterminatePolicy is IAcceptancePolicy {
    function policyId() external pure returns (bytes32) { return keccak256("testonly/indeterminate/v1"); }
    function policyVersion() external pure returns (uint16) { return 1; }
    function requiredRuleMask() external pure returns (uint8) { return 0x0F; }
    function evaluate(Record[] calldata, Record[] calldata, uint16, uint8)
        external pure returns (uint8, uint8, uint8, uint32, uint64)
    {
        return (Verdict.INDETERMINATE, 0, FailCode.POLICY_CALL_FAILED, 0, 0);
    }
}

/// @notice TEST ONLY. Always reverts, used to prove the escrow's try/catch degrades to
///         INDETERMINATE rather than inventing a verdict.
contract RevertingPolicy is IAcceptancePolicy {
    error Nope();
    function policyId() external pure returns (bytes32) { return keccak256("testonly/reverting/v1"); }
    function policyVersion() external pure returns (uint16) { return 1; }
    function requiredRuleMask() external pure returns (uint8) { return 0x0F; }
    function evaluate(Record[] calldata, Record[] calldata, uint16, uint8)
        external pure returns (uint8, uint8, uint8, uint32, uint64)
    {
        revert Nope();
    }
}
