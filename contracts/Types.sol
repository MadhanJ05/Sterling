// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice One catalogue row. Field widths are frozen in docs/encoding.md v1.
struct Record {
    uint32 productId;
    uint64 priceCents;
}

/// @notice Canonical encoding of a delivered/source data bundle.
/// @dev Standard ABI encoding, never abi.encodePacked. See docs/encoding.md section 2.
library Canonical {
    uint16 internal constant ENCODING_VERSION = 1;
    uint16 internal constant MAX_RECORDS = 32;

    function bundleBytes(Record[] memory records) internal pure returns (bytes memory) {
        return abi.encode(ENCODING_VERSION, records);
    }

    function digest(Record[] memory records) internal pure returns (bytes32) {
        return keccak256(abi.encode(ENCODING_VERSION, records));
    }
}

/// @notice Verdict codes. Only a policy contract may produce these.
library Verdict {
    uint8 internal constant INDETERMINATE = 0;
    uint8 internal constant PASS = 1;
    uint8 internal constant FAIL = 2;
}

/// @notice Fail/indeterminate sub-codes. Stable across v1; mirrored in src/shared/policy.ts.
library FailCode {
    uint8 internal constant NONE = 0;
    // FAIL sub-codes
    uint8 internal constant ROW_COUNT_MISMATCH = 1;   // rule 1
    uint8 internal constant MISSING_SOURCE_ID = 2;    // rule 2
    uint8 internal constant DUPLICATE_SOURCE_ID = 3;  // rule 2
    uint8 internal constant UNKNOWN_ID = 4;           // rule 2
    uint8 internal constant PRICE_MISMATCH = 5;       // rule 3
    uint8 internal constant ORDER_VIOLATION = 6;      // rule 4
    // INDETERMINATE sub-codes
    uint8 internal constant UNSUPPORTED_RULE_MASK = 100;
    uint8 internal constant SOURCE_OUT_OF_BOUNDS = 101;
    uint8 internal constant OUTPUT_OUT_OF_BOUNDS = 102;
    uint8 internal constant ROW_COUNT_INCONSISTENT = 103;
    uint8 internal constant POLICY_CALL_FAILED = 104;
}
