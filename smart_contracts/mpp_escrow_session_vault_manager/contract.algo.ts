import {
  Contract,
  Account,
  Asset,
  uint64,
  bytes,
  BoxMap,
  Txn,
  assert,
  itxn,
  op,
  Bytes,
  clone,
  TemplateVar,
  ensureBudget,
  OpUpFeeSource,
} from '@algorandfoundation/algorand-typescript'

/**
 * Compile-time network-specific USDC ASA id.
 * Set via environment variable: TMPL_USDC_ASSET_ID
 */
const USDC_ASSET_ID = TemplateVar<uint64>('USDC_ASSET_ID')

/**
 * SessionInfo: The source of truth for a single stream.
 */
export interface SessionInfo {
  host: Account
  totalDeposit: uint64
  lastSettled: uint64
}

export class MppEscrowSessionVaultManager extends Contract {
  /**
   * BoxMap for session data.
   */
  sessions = BoxMap<bytes, SessionInfo>({ keyPrefix: '' })

  private getViewerSession(viewer: Account, host: Account) {
    return this.sessions(viewer.bytes.concat(host.bytes))
  }

  /**
   * Opens a session.
   */
  openSession(viewer: Account, host: Account): void {
    const viewerSession = this.getViewerSession(viewer, host)

    if (!viewerSession.exists) {
      viewerSession.value = {
        host,
        totalDeposit: 0,
        lastSettled: 0,
      }
    }
  }

  /**
   * Funds MBR/fees pool using ALGO.
   */
  fundMbrPool(payment: { receiver: Account }): void {
    assert(payment.receiver === op.Global.currentApplicationAddress, 'Payment must be to contract')
  }

  /**
   * Opt app account into configured USDC ASA so it can receive deposits.
   * Should be called once by admin/creator.
   */
  optInUsdc(): void {
    assert(Txn.sender === op.Global.creatorAddress, 'Only creator can opt in USDC')

    itxn.assetTransfer({
      xferAsset: Asset(USDC_ASSET_ID),
      assetReceiver: op.Global.currentApplicationAddress,
      assetAmount: 0,
    }).submit()
  }

  /**
   * Viewer locks USDC for the session.
   */
  deposit(viewer: Account, host: Account, payment: { assetReceiver: Account; assetAmount: uint64; xferAsset: Asset }): void {
    const viewerSession = this.getViewerSession(viewer, host)

    assert(viewerSession.exists, 'Session does not exist')
    assert(payment.assetReceiver === op.Global.currentApplicationAddress, 'Asset transfer must be to contract')
    assert(payment.xferAsset === Asset(USDC_ASSET_ID), 'Only configured USDC accepted')

    const currentData = clone(viewerSession.value)
    currentData.totalDeposit += payment.assetAmount
    viewerSession.value = clone(currentData)
  }

  /**
   * Host claims settled USDC amount.  Non-Falcon accounts right now.
   */
  claimVoucher(viewer: Account, host: Account, totalAmountClaimed: uint64, signature: bytes): void {
    // Ensure enough opcode budget for ed25519 verification and settlement logic
    ensureBudget(3000, OpUpFeeSource.GroupCredit)

    const viewerSession = this.getViewerSession(viewer, host)

    assert(viewerSession.exists, 'Session does not exist')

    const data = clone(viewerSession.value)

    assert(Txn.sender === data.host, 'Only host can claim')
    assert(totalAmountClaimed > data.lastSettled, 'Nothing new to claim')
    assert(totalAmountClaimed <= data.totalDeposit, 'Claim exceeds deposit')

    // Message verification
    const msg = op.itob(op.Global.currentApplicationId.id).concat(op.itob(totalAmountClaimed)).concat(Bytes('settle'))
    assert(op.ed25519verify(msg, signature, viewer.bytes), 'Invalid signature')

    const payout: uint64 = totalAmountClaimed - data.lastSettled

    itxn.assetTransfer({
      xferAsset: Asset(USDC_ASSET_ID),
      assetReceiver: data.host,
      assetAmount: payout,
    }).submit()

    data.lastSettled = totalAmountClaimed
    viewerSession.value = clone(data)
  }

  /**
   * Returns the remaining unsettled USDC balance for a viewer session.
   */
  getRemainingBalance(viewer: Account, host: Account): uint64 {
    const viewerSession = this.getViewerSession(viewer, host)
    assert(viewerSession.exists, 'Session does not exist')

    const data = clone(viewerSession.value)
    return data.totalDeposit - data.lastSettled
  }

  /**
   * Closes the session and returns remaining USDC funds.
   */
  refundAndCloseSession(viewer: Account, host: Account): void {
    const viewerSession = this.getViewerSession(viewer, host)

    assert(viewerSession.exists, 'Session does not exist')

    const data = clone(viewerSession.value)

    // Only host can close this session.
    assert(Txn.sender === data.host, 'Only host can close')

    const remainingBalance: uint64 = data.totalDeposit - data.lastSettled

    if (remainingBalance > 0) {
      itxn.assetTransfer({
        xferAsset: Asset(USDC_ASSET_ID),
        assetReceiver: viewer,
        assetAmount: remainingBalance,
      }).submit()
    }

    viewerSession.delete()
  }
}
