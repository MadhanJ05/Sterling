// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Record, Canonical, Verdict, FailCode} from "./Types.sol";
import {IAcceptancePolicy} from "./IAcceptancePolicy.sol";

/// @title Catalogue normalization acceptance policy, version 1 (FROZEN)
/// @notice Four rules, no configuration beyond the frozen rule mask, no state, no owner.
///
/// Rule 1  ROW COUNT   output has exactly `requiredRowCount` rows
/// Rule 2  IDENTITY    every source productId appears exactly once; no productId outside the source
/// Rule 3  PRICE       every output priceCents equals the source priceCents for that productId
/// Rule 4  ORDER       output productIds are strictly increasing
///
/// Evaluation order is fixed and documented: rule 1, then rule 2 (unknown ids, then
/// missing/duplicate in ascending source order), then rule 3, then rule 4. The first violation
/// found in that order is the reported one. This ordering is part of the frozen policy: changing
/// it would change which rule a given flawed delivery is reported against.
contract CatalogueNormalizationPolicyV1 is IAcceptancePolicy {
    uint8 public constant ALL_RULES = 0x0F;

    function policyId() external pure returns (bytes32) {
        return keccak256("acceptance-mvp/catalogue-normalization/v1");
    }

    function policyVersion() external pure returns (uint16) {
        return 1;
    }

    function requiredRuleMask() external pure returns (uint8) {
        return ALL_RULES;
    }

    struct Result {
        uint8 verdict;
        uint8 ruleId;
        uint8 failCode;
        uint32 detailA;
        uint64 detailB;
    }

    function evaluate(
        Record[] calldata source,
        Record[] calldata output,
        uint16 requiredRowCount,
        uint8 ruleMask
    ) external pure returns (uint8, uint8, uint8, uint32, uint64) {
        Result memory r = _evaluate(source, output, requiredRowCount, ruleMask);
        return (r.verdict, r.ruleId, r.failCode, r.detailA, r.detailB);
    }

    function _evaluate(
        Record[] calldata source,
        Record[] calldata output,
        uint16 requiredRowCount,
        uint8 ruleMask
    ) internal pure returns (Result memory r) {
        // ---- Preconditions. These produce INDETERMINATE, never PASS or FAIL. ----
        if (ruleMask != ALL_RULES) return _ind(FailCode.UNSUPPORTED_RULE_MASK, 0, 0);
        if (source.length == 0 || source.length > Canonical.MAX_RECORDS) {
            return _ind(FailCode.SOURCE_OUT_OF_BOUNDS, uint32(source.length), 0);
        }
        if (output.length > Canonical.MAX_RECORDS) {
            return _ind(FailCode.OUTPUT_OUT_OF_BOUNDS, uint32(output.length), 0);
        }
        if (requiredRowCount != source.length) {
            return _ind(FailCode.ROW_COUNT_INCONSISTENT, uint32(requiredRowCount), uint64(source.length));
        }

        // ---- Rule 1: row count ----
        if (output.length != requiredRowCount) {
            return _fail(1, FailCode.ROW_COUNT_MISMATCH, uint32(output.length), uint64(requiredRowCount));
        }

        // ---- Rule 2: identity ----
        r = _rule2(source, output);
        if (r.verdict != Verdict.PASS) return r;

        // ---- Rule 3: prices preserved ----
        r = _rule3(source, output);
        if (r.verdict != Verdict.PASS) return r;

        // ---- Rule 4: strictly increasing productId ----
        return _rule4(output);
    }

    /// @dev 2a: no productId outside the approved source, scanned in output order.
    ///      2b: every source productId appears exactly once, scanned in source order.
    function _rule2(Record[] calldata source, Record[] calldata output) internal pure returns (Result memory) {
        for (uint256 j = 0; j < output.length; j++) {
            bool known = false;
            for (uint256 i = 0; i < source.length; i++) {
                if (source[i].productId == output[j].productId) {
                    known = true;
                    break;
                }
            }
            if (!known) return _fail(2, FailCode.UNKNOWN_ID, output[j].productId, uint64(j));
        }
        for (uint256 i = 0; i < source.length; i++) {
            uint64 occurrences = 0;
            for (uint256 j = 0; j < output.length; j++) {
                if (output[j].productId == source[i].productId) occurrences++;
            }
            if (occurrences == 0) return _fail(2, FailCode.MISSING_SOURCE_ID, source[i].productId, 0);
            if (occurrences > 1) return _fail(2, FailCode.DUPLICATE_SOURCE_ID, source[i].productId, occurrences);
        }
        return _pass();
    }

    function _rule3(Record[] calldata source, Record[] calldata output) internal pure returns (Result memory) {
        for (uint256 j = 0; j < output.length; j++) {
            for (uint256 i = 0; i < source.length; i++) {
                if (source[i].productId == output[j].productId) {
                    if (source[i].priceCents != output[j].priceCents) {
                        // detailB is the approved price. The submitted price is in contract storage.
                        return _fail(3, FailCode.PRICE_MISMATCH, output[j].productId, source[i].priceCents);
                    }
                    break;
                }
            }
        }
        return _pass();
    }

    function _rule4(Record[] calldata output) internal pure returns (Result memory) {
        for (uint256 j = 1; j < output.length; j++) {
            if (output[j].productId <= output[j - 1].productId) {
                return _fail(4, FailCode.ORDER_VIOLATION, output[j].productId, uint64(output[j - 1].productId));
            }
        }
        return _pass();
    }

    function _pass() private pure returns (Result memory r) {
        r.verdict = Verdict.PASS;
    }

    function _fail(uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB)
        private pure returns (Result memory r)
    {
        r.verdict = Verdict.FAIL;
        r.ruleId = ruleId;
        r.failCode = failCode;
        r.detailA = detailA;
        r.detailB = detailB;
    }

    function _ind(uint8 failCode, uint32 detailA, uint64 detailB) private pure returns (Result memory r) {
        r.verdict = Verdict.INDETERMINATE;
        r.failCode = failCode;
        r.detailA = detailA;
        r.detailB = detailB;
    }

    /// @notice Exposed so tests can prove the TypeScript encoder and this contract agree byte for byte.
    function canonicalBundleBytes(Record[] calldata records) external pure returns (bytes memory) {
        return abi.encode(Canonical.ENCODING_VERSION, records);
    }

    function canonicalDigest(Record[] calldata records) external pure returns (bytes32) {
        return keccak256(abi.encode(Canonical.ENCODING_VERSION, records));
    }
}
