// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Record, Canonical, Verdict, FailCode} from "./Types.sol";
import {IAcceptancePolicy} from "./IAcceptancePolicy.sol";

/// @title AcceptanceEscrow
/// @notice Holds agreed terms, escrowed test tokens and one delivery per job, and settles by
///         asking an immutable policy contract. There is deliberately no owner, no admin, no
///         upgrade proxy, no pause, no verdict argument and no recipient override anywhere in
///         this contract. The deployer receives no privilege of any kind.
///
///         State machine:
///           CREATED -> ACCEPTED -> FUNDED -> SUBMITTED -> PAID | REJECTED
///           CREATED | ACCEPTED            -> CANCELLED        (no funds are held yet)
///           FUNDED  | SUBMITTED           -> EXPIRED          (at or after settlementExpiry)
///
///         Boundary rules, frozen:
///           submitDelivery  allowed while block.timestamp <= deliveryDeadline
///           submitAndSettle allowed while block.timestamp <= deliveryDeadline AND < settlementExpiry
///           settle          allowed while block.timestamp <  settlementExpiry
///           refundExpired   allowed while block.timestamp >= settlementExpiry
///
///         Payment asset: ONE ERC-20, fixed immutably at construction and required to have code
///         at that moment. An earlier version accepted any address the buyer named, which let an
///         ordinary account with no code reach PAID because a call to a codeless address succeeds
///         with empty return data. Transfers now go through OpenZeppelin SafeERC20 and the
///         escrow additionally verifies the exact balance delta, so a fee-on-transfer or
///         rebasing token reverts rather than silently under-funding a job.
contract AcceptanceEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        NONE,
        CREATED,
        ACCEPTED,
        FUNDED,
        SUBMITTED,
        PAID,
        REJECTED,
        EXPIRED,
        CANCELLED
    }

    struct Terms {
        address buyer;
        address provider;
        address paymentToken;
        uint256 amount;
        bytes32 sourceDigest;
        uint16 requiredRowCount;
        bytes32 policyId;
        uint16 policyVersion;
        uint8 ruleMask;
        bytes32 packDigest;
        uint64 deliveryDeadline;
        uint64 settlementExpiry;
    }

    struct CreateParams {
        address provider;
        address paymentToken;
        uint256 amount;
        uint16 requiredRowCount;
        uint8 ruleMask;
        bytes32 packDigest;
        uint8 unsupportedClauseCount;
        /// @dev Windows, not absolute deadlines. The contract derives the deadlines from the
        ///      block it is mined in, so `deliveryDeadline - createdAt` is exactly what the
        ///      approved pack promised. A caller supplying absolute timestamps computed from an
        ///      earlier block would always be a second or two short, which made an exact
        ///      agreement check impossible and a sloppy one the only option.
        uint32 deliveryWindowSeconds;
        uint32 settlementWindowSeconds;
    }

    struct Job {
        Terms terms;
        bytes32 termsDigest;
        Status status;
        bytes32 deliveryDigest;
        uint64 createdAt;
        uint64 submittedAt;
        uint64 settledAt;
        uint8 verdict;
        uint8 ruleId;
        uint8 failCode;
        uint32 detailA;
        uint64 detailB;
    }

    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "AcceptanceTermsV1(uint256 chainId,address escrow,uint256 jobId,address buyer,address provider,address paymentToken,uint256 amount,bytes32 sourceDigest,uint16 requiredRowCount,bytes32 policyId,uint16 policyVersion,uint8 ruleMask,bytes32 packDigest,uint64 deliveryDeadline,uint64 settlementExpiry)"
    );

    uint64 public constant MIN_DELIVERY_WINDOW = 5;
    uint64 public constant MIN_SETTLEMENT_WINDOW = 10;

    /// @notice Set once at construction and never writable. No function can change it, so the
    ///         policy governing an existing job cannot be replaced.
    IAcceptancePolicy public immutable policy;
    /// @notice The only asset this escrow will ever move. Set once, never writable.
    IERC20 public immutable paymentToken;
    bytes32 public immutable expectedPolicyId;
    uint16 public immutable expectedPolicyVersion;
    uint8 public immutable expectedRuleMask;

    uint256 public jobCount;
    /// @notice Sum of `amount` over every job currently holding escrowed funds.
    uint256 public totalLocked;

    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => Record[]) private _source;
    mapping(uint256 => Record[]) private _output;

    uint256 private _reentrancy = 1;

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed provider,
        bytes32 termsDigest,
        bytes32 sourceDigest,
        bytes32 packDigest,
        uint256 amount
    );
    event JobAccepted(uint256 indexed jobId, address indexed provider, bytes32 termsDigest);
    event JobFunded(uint256 indexed jobId, address indexed buyer, uint256 amount);
    event DeliverySubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliveryDigest, uint16 rowCount);
    event JobSettled(
        uint256 indexed jobId,
        address indexed settledBy,
        uint8 verdict,
        uint8 ruleId,
        uint8 failCode,
        uint32 detailA,
        uint64 detailB,
        address paidTo,
        uint256 amount
    );
    event JobExpired(uint256 indexed jobId, address indexed refundedTo, uint256 amount);
    event JobCancelled(uint256 indexed jobId);

    error Reentrancy();
    error NotBuyer(address caller, address buyer);
    error NotProvider(address caller, address provider);
    error WrongStatus(uint256 jobId, Status actual, Status expected);
    error TermsDigestMismatch(bytes32 supplied, bytes32 stored);
    error ZeroAddress();
    error ProviderIsBuyer();
    error ZeroAmount();
    error BadRecordCount(uint256 count);
    error RowCountMismatch(uint16 requiredRowCount, uint256 sourceLength);
    error DuplicateSourceId(uint32 productId);
    error UnsupportedRuleMask(uint8 supplied, uint8 required);
    error UnsupportedClausesPresent(uint8 count);
    error MissingPackDigest();
    error DeliveryWindowTooShort(uint32 supplied, uint64 minimum);
    error SettlementWindowTooShort(uint32 deliveryWindow, uint32 settlementWindow);
    error PastDeliveryDeadline(uint64 nowTs, uint64 deliveryDeadline);
    error SettlementWindowClosed(uint64 nowTs, uint64 settlementExpiry);
    error NotYetExpired(uint64 nowTs, uint64 settlementExpiry);
    error EvaluationIndeterminate(uint8 failCode);
    error PolicyMismatch();
    error UnsupportedPaymentToken(address supplied, address approved);
    error PaymentTokenHasNoCode(address token);
    error UnexpectedTokenAmount(uint256 expected, uint256 actual);

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    constructor(IAcceptancePolicy policy_, IERC20 paymentToken_) {
        if (address(policy_) == address(0) || address(paymentToken_) == address(0)) revert ZeroAddress();
        // A payment "token" with no code would make every transfer a no-op that reports success.
        if (address(paymentToken_).code.length == 0) revert PaymentTokenHasNoCode(address(paymentToken_));
        paymentToken = paymentToken_;
        policy = policy_;
        expectedPolicyId = policy_.policyId();
        expectedPolicyVersion = policy_.policyVersion();
        expectedRuleMask = policy_.requiredRuleMask();
    }

    // ---------------------------------------------------------------- create

    /// @notice Buyer creates a job. The contract itself computes the source commitment and the
    ///         terms digest; neither is supplied by the caller.
    function createJob(CreateParams calldata p, Record[] calldata source) external returns (uint256 jobId) {
        if (p.provider == address(0) || p.paymentToken == address(0)) revert ZeroAddress();
        if (p.paymentToken != address(paymentToken)) {
            revert UnsupportedPaymentToken(p.paymentToken, address(paymentToken));
        }
        if (p.provider == msg.sender) revert ProviderIsBuyer();
        if (p.amount == 0) revert ZeroAmount();
        if (source.length == 0 || source.length > Canonical.MAX_RECORDS) revert BadRecordCount(source.length);
        if (p.requiredRowCount != source.length) revert RowCountMismatch(p.requiredRowCount, source.length);
        if (p.ruleMask != expectedRuleMask) revert UnsupportedRuleMask(p.ruleMask, expectedRuleMask);
        // A material clause that is not executable cannot enter the automatic flow. The only
        // route forward is an explicit scope revision producing a new pack version.
        if (p.unsupportedClauseCount != 0) revert UnsupportedClausesPresent(p.unsupportedClauseCount);
        if (p.packDigest == bytes32(0)) revert MissingPackDigest();
        if (p.deliveryWindowSeconds < MIN_DELIVERY_WINDOW) {
            revert DeliveryWindowTooShort(p.deliveryWindowSeconds, MIN_DELIVERY_WINDOW);
        }
        if (p.settlementWindowSeconds < MIN_SETTLEMENT_WINDOW) {
            revert SettlementWindowTooShort(p.deliveryWindowSeconds, p.settlementWindowSeconds);
        }
        uint64 deliveryDeadline = uint64(block.timestamp) + p.deliveryWindowSeconds;
        uint64 settlementExpiry = deliveryDeadline + p.settlementWindowSeconds;

        for (uint256 i = 0; i < source.length; i++) {
            for (uint256 k = i + 1; k < source.length; k++) {
                if (source[i].productId == source[k].productId) revert DuplicateSourceId(source[i].productId);
            }
        }

        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        j.terms = Terms({
            buyer: msg.sender,
            provider: p.provider,
            paymentToken: p.paymentToken,
            amount: p.amount,
            sourceDigest: Canonical.digest(source),
            requiredRowCount: p.requiredRowCount,
            policyId: expectedPolicyId,
            policyVersion: expectedPolicyVersion,
            ruleMask: p.ruleMask,
            packDigest: p.packDigest,
            deliveryDeadline: deliveryDeadline,
            settlementExpiry: settlementExpiry
        });
        j.termsDigest = _termsDigest(jobId, j.terms);
        j.status = Status.CREATED;
        j.createdAt = uint64(block.timestamp);

        Record[] storage s = _source[jobId];
        for (uint256 i = 0; i < source.length; i++) {
            s.push(source[i]);
        }

        emit JobCreated(
            jobId, msg.sender, p.provider, j.termsDigest, j.terms.sourceDigest, p.packDigest, p.amount
        );
    }

    // ------------------------------------------------------------ acceptance

    /// @notice Provider accepts exactly the stored terms. `expectedTermsDigest` is the provider's
    ///         authenticated statement of what it believes it is agreeing to.
    function acceptJob(uint256 jobId, bytes32 expectedTermsDigest) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.CREATED) revert WrongStatus(jobId, j.status, Status.CREATED);
        if (msg.sender != j.terms.provider) revert NotProvider(msg.sender, j.terms.provider);
        if (expectedTermsDigest != j.termsDigest) revert TermsDigestMismatch(expectedTermsDigest, j.termsDigest);
        j.status = Status.ACCEPTED;
        emit JobAccepted(jobId, msg.sender, j.termsDigest);
    }

    /// @notice Buyer funds after the provider has accepted, with time left to deliver.
    function fundJob(uint256 jobId, bytes32 expectedTermsDigest) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.ACCEPTED) revert WrongStatus(jobId, j.status, Status.ACCEPTED);
        if (msg.sender != j.terms.buyer) revert NotBuyer(msg.sender, j.terms.buyer);
        if (expectedTermsDigest != j.termsDigest) revert TermsDigestMismatch(expectedTermsDigest, j.termsDigest);
        if (uint64(block.timestamp) >= j.terms.deliveryDeadline) {
            revert PastDeliveryDeadline(uint64(block.timestamp), j.terms.deliveryDeadline);
        }
        j.status = Status.FUNDED;
        totalLocked += j.terms.amount;
        _pull(j.terms.paymentToken, msg.sender, j.terms.amount);
        emit JobFunded(jobId, msg.sender, j.terms.amount);
    }

    /// @notice Buyer abandons a job that holds no funds. Cannot touch a funded job: the status
    ///         check below only admits CREATED and ACCEPTED.
    function cancelBeforeFunding(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.CREATED && j.status != Status.ACCEPTED) {
            revert WrongStatus(jobId, j.status, Status.CREATED);
        }
        if (msg.sender != j.terms.buyer) revert NotBuyer(msg.sender, j.terms.buyer);
        j.status = Status.CANCELLED;
        emit JobCancelled(jobId);
    }

    // -------------------------------------------------------------- delivery

    /// @notice Provider submits once. Only bounds are checked here; a nonconforming but
    ///         representable delivery is accepted so that a genuine FAIL can be demonstrated.
    function submitDelivery(uint256 jobId, Record[] calldata output) external {
        _recordDelivery(jobId, output);
    }

    /// @notice Submit and settle in one transaction.
    ///
    ///         The checker is small, synchronous and bounded at 32 rows, so there is no reason for
    ///         a conforming delivery to sit waiting for a separate settlement request. This path
    ///         records the delivery, evaluates it, and pays or refunds atomically.
    ///
    ///         Error behaviour, fixed before implementation and identical to the two-step path
    ///         except that nothing is left recorded:
    ///           - If the policy cannot complete, the WHOLE transaction reverts. The delivery is
    ///             not stored, so the provider may retry with `submitDelivery` (two-step) or with
    ///             this function, up to the delivery deadline. If it never succeeds, the agreed
    ///             expiry refund applies. There is no admin override, here or anywhere.
    ///           - Past the delivery deadline this reverts like `submitDelivery`.
    ///           - At or after settlement expiry this reverts like `settle`, because the contract
    ///             must not pay after expiry. The provider can still record the delivery with
    ///             `submitDelivery` for the record, but the escrow will refund on expiry.
    ///
    ///         It grants no new authority: the caller must be the provider, supplies rows and not
    ///         a verdict, and the same immutable policy decides the outcome.
    function submitAndSettle(uint256 jobId, Record[] calldata output) external nonReentrant {
        Job storage j = _jobs[jobId];
        // Checked before recording so that a delivery is never stored into a job that cannot
        // then be settled in this same transaction.
        if (j.status == Status.FUNDED && uint64(block.timestamp) >= j.terms.settlementExpiry) {
            revert SettlementWindowClosed(uint64(block.timestamp), j.terms.settlementExpiry);
        }
        _recordDelivery(jobId, output);
        _settle(jobId, j);
    }

    function _recordDelivery(uint256 jobId, Record[] calldata output) internal {
        Job storage j = _jobs[jobId];
        if (j.status != Status.FUNDED) revert WrongStatus(jobId, j.status, Status.FUNDED);
        if (msg.sender != j.terms.provider) revert NotProvider(msg.sender, j.terms.provider);
        if (uint64(block.timestamp) > j.terms.deliveryDeadline) {
            revert PastDeliveryDeadline(uint64(block.timestamp), j.terms.deliveryDeadline);
        }
        if (output.length > Canonical.MAX_RECORDS) revert BadRecordCount(output.length);

        Record[] storage o = _output[jobId];
        for (uint256 i = 0; i < output.length; i++) {
            o.push(output[i]);
        }
        j.deliveryDigest = Canonical.digest(output);
        j.status = Status.SUBMITTED;
        j.submittedAt = uint64(block.timestamp);
        emit DeliverySubmitted(jobId, msg.sender, j.deliveryDigest, uint16(output.length));
    }

    // ------------------------------------------------------------ settlement

    /// @notice Anyone may request settlement. The request carries a job ID and nothing else:
    ///         there is no verdict argument and no way to supply alternative rows. The contract
    ///         reads its own stored source and stored delivery and asks the immutable policy.
    function settle(uint256 jobId) external nonReentrant {
        _settle(jobId, _jobs[jobId]);
    }

    function _settle(uint256 jobId, Job storage j) internal {
        if (j.status != Status.SUBMITTED) revert WrongStatus(jobId, j.status, Status.SUBMITTED);
        if (uint64(block.timestamp) >= j.terms.settlementExpiry) {
            revert SettlementWindowClosed(uint64(block.timestamp), j.terms.settlementExpiry);
        }

        (uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB) = _evaluate(jobId, j);

        // An evaluation that cannot complete leaves the job exactly where it was. There is no
        // admin override: the agreed expiry path is the only remaining route.
        if (verdict == Verdict.INDETERMINATE) revert EvaluationIndeterminate(failCode);

        address paidTo = verdict == Verdict.PASS ? j.terms.provider : j.terms.buyer;
        uint256 amount = j.terms.amount;

        j.status = verdict == Verdict.PASS ? Status.PAID : Status.REJECTED;
        j.verdict = verdict;
        j.ruleId = ruleId;
        j.failCode = failCode;
        j.detailA = detailA;
        j.detailB = detailB;
        j.settledAt = uint64(block.timestamp);
        totalLocked -= amount;

        _push(j.terms.paymentToken, paidTo, amount);
        emit JobSettled(jobId, msg.sender, verdict, ruleId, failCode, detailA, detailB, paidTo, amount);
    }

    /// @notice At or after expiry the escrow returns to the buyer. This is a timeout rule. It is
    ///         not a finding that the delivered work was bad.
    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.FUNDED && j.status != Status.SUBMITTED) {
            revert WrongStatus(jobId, j.status, Status.FUNDED);
        }
        if (uint64(block.timestamp) < j.terms.settlementExpiry) {
            revert NotYetExpired(uint64(block.timestamp), j.terms.settlementExpiry);
        }
        uint256 amount = j.terms.amount;
        j.status = Status.EXPIRED;
        j.settledAt = uint64(block.timestamp);
        totalLocked -= amount;
        _push(j.terms.paymentToken, j.terms.buyer, amount);
        emit JobExpired(jobId, j.terms.buyer, amount);
    }

    // ------------------------------------------------------------------ views

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function getSource(uint256 jobId) external view returns (Record[] memory) {
        return _source[jobId];
    }

    function getOutput(uint256 jobId) external view returns (Record[] memory) {
        return _output[jobId];
    }

    /// @notice What `settle` would return right now, without changing anything.
    function previewSettlement(uint256 jobId)
        external
        view
        returns (uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB)
    {
        Job storage j = _jobs[jobId];
        return _evaluate(jobId, j);
    }

    /// @notice Recompute the terms digest for stored terms. Used by clients to check their own
    ///         mirror implementation against the contract.
    function termsDigestOf(uint256 jobId) external view returns (bytes32) {
        return _termsDigest(jobId, _jobs[jobId].terms);
    }

    // -------------------------------------------------------------- internals

    function _evaluate(uint256 jobId, Job storage j)
        internal
        view
        returns (uint8, uint8, uint8, uint32, uint64)
    {
        try policy.evaluate(_source[jobId], _output[jobId], j.terms.requiredRowCount, j.terms.ruleMask) returns (
            uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB
        ) {
            return (verdict, ruleId, failCode, detailA, detailB);
        } catch {
            return (Verdict.INDETERMINATE, 0, FailCode.POLICY_CALL_FAILED, 0, 0);
        }
    }

    /// @dev Every one of the 16 fields is a static ABI type, so the concatenation of these two
    ///      standard encodings is byte-for-byte identical to a single 16-argument abi.encode.
    ///      It is split only to stay inside the EVM stack limit without via-IR. The equality is
    ///      asserted against the TypeScript single-call encoder in tests/terms-digest.test.ts.
    function _termsDigest(uint256 jobId, Terms memory t) internal view returns (bytes32) {
        bytes memory head = abi.encode(
            TERMS_TYPEHASH,
            block.chainid,
            address(this),
            jobId,
            t.buyer,
            t.provider,
            t.paymentToken,
            t.amount
        );
        bytes memory tail = abi.encode(
            t.sourceDigest,
            t.requiredRowCount,
            t.policyId,
            t.policyVersion,
            t.ruleMask,
            t.packDigest,
            t.deliveryDeadline,
            t.settlementExpiry
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @dev Pull exactly `amount` in. A token that delivers less (fee-on-transfer, rebasing) is
    ///      not supported and reverts here rather than leaving a job under-funded.
    function _pull(address token, address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedTokenAmount(amount, received);
    }

    /// @dev Push exactly `amount` out. Both legs are checked: the escrow must be debited by
    ///      exactly `amount` AND the recipient must be credited by exactly `amount`.
    ///
    ///      Checking only the debit was not enough. A token can take the full amount from the
    ///      sender and deliver less to the recipient, which let a job reach PAID with the supplier
    ///      short-changed — reproduced by the independent review of 14 September 2026 with a token
    ///      charging a 10% outgoing fee. The recipient-credit check is the one that matters for
    ///      "the agreed amount was actually paid"; the debit check is kept because it catches a
    ///      token that moves more than it was asked to.
    function _push(address token, address to, uint256 amount) internal {
        uint256 beforeSelf = IERC20(token).balanceOf(address(this));
        uint256 beforeTo = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        uint256 debited = beforeSelf - IERC20(token).balanceOf(address(this));
        uint256 credited = IERC20(token).balanceOf(to) - beforeTo;
        if (credited != amount) revert UnexpectedTokenAmount(amount, credited);
        if (debited != amount) revert UnexpectedTokenAmount(amount, debited);
    }
}
