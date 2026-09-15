// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Record, Canonical, Verdict, FailCode} from "../Types.sol";
import {IAcceptancePolicy} from "../IAcceptancePolicy.sol";

/// @title CommitmentEscrowExperiment — EXPERIMENT, NOT THE PRODUCT
///
/// @notice An alternative storage layout, built only to be measured against AcceptanceEscrow.
///         Nothing in the application uses it. It is not deployed by `npm start` or `npm run demo`.
///
///         The headline difference: this contract stores the source and delivery **commitments**
///         rather than the rows themselves. Whoever settles must supply the rows, and the contract
///         rehashes them and compares before it will evaluate anything.
///
///         It is NOT a storage-only variant, and the measured gas difference must not be
///         attributed entirely to storing fewer rows. This contract also omits, relative to
///         AcceptanceEscrow: the stored terms digest and the `expectedTermsDigest` arguments on
///         acceptance and funding, the policy id/version fields in Terms, `createdAt`/`submittedAt`
///         /`settledAt`, the `previewSettlement` and `termsDigestOf` views, cancellation before
///         funding, and several `createJob` validations. Before any of this could be promoted it
///         would have to regain that behaviour, be tested at parity, and be remeasured.
///
///         Verification is not weakened. It is moved, and the move is checked:
///           - Source rows that do not hash to the committed sourceDigest revert with
///             `SourceDataMismatch`. Delivery rows that do not hash to the committed
///             deliveryDigest revert with `DeliveryDataMismatch`.
///           - Neither is ever a FAIL. A revert leaves the job exactly where it was, so wrong
///             data supplied by a third party can never refund an honest provider's job. That is
///             the specific failure this design could have introduced, and it is tested.
///           - There is still no verdict argument, no owner, and no admin override.
///
///         What it costs: the rows must be available off chain to settle at all. This contract
///         does not make the data private — calldata is public — and it does not remove the
///         data-availability requirement, it relocates it onto the parties.
contract CommitmentEscrowExperiment {
    using SafeERC20 for IERC20;

    enum Status { NONE, CREATED, ACCEPTED, FUNDED, SUBMITTED, PAID, REJECTED, EXPIRED, CANCELLED }

    struct Terms {
        address buyer;
        address provider;
        uint256 amount;
        bytes32 sourceDigest;
        uint16 requiredRowCount;
        uint8 ruleMask;
        bytes32 packDigest;
        uint64 deliveryDeadline;
        uint64 settlementExpiry;
    }

    struct CreateParams {
        address provider;
        uint256 amount;
        uint16 requiredRowCount;
        uint8 ruleMask;
        bytes32 packDigest;
        uint8 unsupportedClauseCount;
        uint32 deliveryWindowSeconds;
        uint32 settlementWindowSeconds;
    }

    struct Job {
        Terms terms;
        Status status;
        bytes32 deliveryDigest;
        uint64 createdAt;
        uint8 verdict;
        uint8 ruleId;
        uint8 failCode;
        uint32 detailA;
        uint64 detailB;
    }

    uint64 public constant MIN_DELIVERY_WINDOW = 5;
    uint64 public constant MIN_SETTLEMENT_WINDOW = 10;

    IAcceptancePolicy public immutable policy;
    IERC20 public immutable paymentToken;
    uint8 public immutable expectedRuleMask;

    uint256 public jobCount;
    uint256 public totalLocked;
    mapping(uint256 => Job) private _jobs;
    uint256 private _reentrancy = 1;

    event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed provider, bytes32 sourceDigest);
    event JobAccepted(uint256 indexed jobId);
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event DeliverySubmitted(uint256 indexed jobId, bytes32 deliveryDigest, uint16 rowCount);
    event JobSettled(uint256 indexed jobId, uint8 verdict, uint8 ruleId, address paidTo, uint256 amount);
    event JobExpired(uint256 indexed jobId, uint256 amount);

    error Reentrancy();
    error WrongStatus(uint256 jobId, Status actual, Status expected);
    error NotBuyer();
    error NotProvider();
    error BadRecordCount(uint256 count);
    error UnsupportedRuleMask();
    error UnsupportedClausesPresent(uint8 count);
    error WindowTooShort();
    error PastDeliveryDeadline();
    error SettlementWindowClosed();
    error NotYetExpired();
    error EvaluationIndeterminate(uint8 failCode);
    /// @dev Distinct from any verdict. Supplying the wrong rows is a caller error, never a finding.
    error SourceDataMismatch(bytes32 committed, bytes32 supplied);
    error DeliveryDataMismatch(bytes32 committed, bytes32 supplied);
    error ZeroAddress();
    error PaymentTokenHasNoCode();
    error UnexpectedTokenAmount();

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    constructor(IAcceptancePolicy policy_, IERC20 paymentToken_) {
        if (address(policy_) == address(0) || address(paymentToken_) == address(0)) revert ZeroAddress();
        if (address(paymentToken_).code.length == 0) revert PaymentTokenHasNoCode();
        policy = policy_;
        paymentToken = paymentToken_;
        expectedRuleMask = policy_.requiredRuleMask();
    }

    function createJob(CreateParams calldata p, Record[] calldata source) external returns (uint256 jobId) {
        if (p.provider == address(0) || p.provider == msg.sender) revert ZeroAddress();
        if (source.length == 0 || source.length > Canonical.MAX_RECORDS) revert BadRecordCount(source.length);
        if (p.requiredRowCount != source.length) revert BadRecordCount(p.requiredRowCount);
        if (p.ruleMask != expectedRuleMask) revert UnsupportedRuleMask();
        if (p.unsupportedClauseCount != 0) revert UnsupportedClausesPresent(p.unsupportedClauseCount);
        if (p.deliveryWindowSeconds < MIN_DELIVERY_WINDOW || p.settlementWindowSeconds < MIN_SETTLEMENT_WINDOW) {
            revert WindowTooShort();
        }
        for (uint256 i = 0; i < source.length; i++) {
            for (uint256 k = i + 1; k < source.length; k++) {
                if (source[i].productId == source[k].productId) revert BadRecordCount(i);
            }
        }

        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        uint64 deliveryDeadline = uint64(block.timestamp) + p.deliveryWindowSeconds;
        j.terms = Terms({
            buyer: msg.sender,
            provider: p.provider,
            amount: p.amount,
            // The commitment is stored; the rows are not. This is the whole experiment.
            sourceDigest: Canonical.digest(source),
            requiredRowCount: p.requiredRowCount,
            ruleMask: p.ruleMask,
            packDigest: p.packDigest,
            deliveryDeadline: deliveryDeadline,
            settlementExpiry: deliveryDeadline + p.settlementWindowSeconds
        });
        j.status = Status.CREATED;
        j.createdAt = uint64(block.timestamp);
        emit JobCreated(jobId, msg.sender, p.provider, j.terms.sourceDigest);
    }

    function acceptJob(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.CREATED) revert WrongStatus(jobId, j.status, Status.CREATED);
        if (msg.sender != j.terms.provider) revert NotProvider();
        j.status = Status.ACCEPTED;
        emit JobAccepted(jobId);
    }

    function fundJob(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.ACCEPTED) revert WrongStatus(jobId, j.status, Status.ACCEPTED);
        if (msg.sender != j.terms.buyer) revert NotBuyer();
        if (uint64(block.timestamp) >= j.terms.deliveryDeadline) revert PastDeliveryDeadline();
        j.status = Status.FUNDED;
        totalLocked += j.terms.amount;
        uint256 before = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), j.terms.amount);
        if (paymentToken.balanceOf(address(this)) - before != j.terms.amount) revert UnexpectedTokenAmount();
        emit JobFunded(jobId, j.terms.amount);
    }

    function submitDelivery(uint256 jobId, Record[] calldata output) external {
        _recordDelivery(jobId, output);
    }

    /// @notice Record, evaluate and settle in one transaction. The source rows must be supplied
    ///         because this contract did not keep them; they are rehashed against the commitment
    ///         made at creation before anything is evaluated.
    function submitAndSettle(uint256 jobId, Record[] calldata source, Record[] calldata output)
        external
        nonReentrant
    {
        Job storage j = _jobs[jobId];
        if (j.status == Status.FUNDED && uint64(block.timestamp) >= j.terms.settlementExpiry) {
            revert SettlementWindowClosed();
        }
        _recordDelivery(jobId, output);
        _settle(jobId, j, source, output);
    }

    /// @notice Settle a job whose delivery was recorded separately.
    function settle(uint256 jobId, Record[] calldata source, Record[] calldata output) external nonReentrant {
        _settle(jobId, _jobs[jobId], source, output);
    }

    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.FUNDED && j.status != Status.SUBMITTED) revert WrongStatus(jobId, j.status, Status.FUNDED);
        if (uint64(block.timestamp) < j.terms.settlementExpiry) revert NotYetExpired();
        uint256 amount = j.terms.amount;
        j.status = Status.EXPIRED;
        totalLocked -= amount;
        _push(j.terms.buyer, amount);
        emit JobExpired(jobId, amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // -------------------------------------------------------------- internals

    /// @dev Mirrors AcceptanceEscrow._push: both the debit and the credit must equal `amount`.
    function _push(address to, uint256 amount) internal {
        uint256 beforeSelf = paymentToken.balanceOf(address(this));
        uint256 beforeTo = paymentToken.balanceOf(to);
        paymentToken.safeTransfer(to, amount);
        if (paymentToken.balanceOf(to) - beforeTo != amount) revert UnexpectedTokenAmount();
        if (beforeSelf - paymentToken.balanceOf(address(this)) != amount) revert UnexpectedTokenAmount();
    }

    function _recordDelivery(uint256 jobId, Record[] calldata output) internal {
        Job storage j = _jobs[jobId];
        if (j.status != Status.FUNDED) revert WrongStatus(jobId, j.status, Status.FUNDED);
        if (msg.sender != j.terms.provider) revert NotProvider();
        if (uint64(block.timestamp) > j.terms.deliveryDeadline) revert PastDeliveryDeadline();
        if (output.length > Canonical.MAX_RECORDS) revert BadRecordCount(output.length);
        j.deliveryDigest = Canonical.digest(output);
        j.status = Status.SUBMITTED;
        emit DeliverySubmitted(jobId, j.deliveryDigest, uint16(output.length));
    }

    function _settle(uint256 jobId, Job storage j, Record[] calldata source, Record[] calldata output) internal {
        if (j.status != Status.SUBMITTED) revert WrongStatus(jobId, j.status, Status.SUBMITTED);
        if (uint64(block.timestamp) >= j.terms.settlementExpiry) revert SettlementWindowClosed();

        // Bind the supplied data to what was committed. A mismatch is a caller error and reverts;
        // it is never allowed to become a FAIL that would refund an honest provider's job.
        bytes32 suppliedSource = Canonical.digest(source);
        if (suppliedSource != j.terms.sourceDigest) revert SourceDataMismatch(j.terms.sourceDigest, suppliedSource);
        bytes32 suppliedDelivery = Canonical.digest(output);
        if (suppliedDelivery != j.deliveryDigest) revert DeliveryDataMismatch(j.deliveryDigest, suppliedDelivery);

        (uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB) =
            _evaluate(j, source, output);
        if (verdict == Verdict.INDETERMINATE) revert EvaluationIndeterminate(failCode);

        address paidTo = verdict == Verdict.PASS ? j.terms.provider : j.terms.buyer;
        uint256 amount = j.terms.amount;
        j.status = verdict == Verdict.PASS ? Status.PAID : Status.REJECTED;
        j.verdict = verdict;
        j.ruleId = ruleId;
        j.failCode = failCode;
        j.detailA = detailA;
        j.detailB = detailB;
        totalLocked -= amount;
        _push(paidTo, amount);
        emit JobSettled(jobId, verdict, ruleId, paidTo, amount);
    }

    function _evaluate(Job storage j, Record[] calldata source, Record[] calldata output)
        internal
        view
        returns (uint8, uint8, uint8, uint32, uint64)
    {
        uint16 rowCount = j.terms.requiredRowCount;
        uint8 mask = j.terms.ruleMask;
        try policy.evaluate(source, output, rowCount, mask) returns (
            uint8 verdict, uint8 ruleId, uint8 failCode, uint32 detailA, uint64 detailB
        ) {
            return (verdict, ruleId, failCode, detailA, detailB);
        } catch {
            return (Verdict.INDETERMINATE, 0, FailCode.POLICY_CALL_FAILED, 0, 0);
        }
    }
}
