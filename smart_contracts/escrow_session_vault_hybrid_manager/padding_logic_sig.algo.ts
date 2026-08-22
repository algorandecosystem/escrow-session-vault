import {
  Account,
  Application,
  Bytes,
  LogicSig,
  TemplateVar,
  Txn,
  assert,
  bytes,
  gtxn,
  logicsig,
  op,
  uint64,
} from '@algorandfoundation/algorand-typescript'

const HYBRID_APP_ID = TemplateVar<uint64>('HYBRID_APP_ID')
const CHANNEL_ID = TemplateVar<bytes>('CHANNEL_ID')

/**
 * A constrained companion LogicSig used solely to add 1,000 bytes of pooled
 * LogicSig-argument capacity for the Falcon settlement voucher.
 */
@logicsig({ avmVersion: 13, name: 'EscrowSessionSettlementPaddingLogicSig' })
export class EscrowSessionSettlementPaddingLogicSig extends LogicSig {
  program(): boolean {
    assert(op.Global.groupSize === 2, 'Padding requires a two-LogicSig transaction group')
    assert(Txn.groupIndex === 1, 'Padding must be second in group')
    assert(Txn.receiver === Txn.sender, 'Padding payment must be self-payment')
    assert(Txn.amount === 0, 'Padding payment amount must be zero')
    assert(Txn.fee === 0, 'Padding payment fee must be zero')
    assert(Txn.rekeyTo === Account(), 'Padding rekey not allowed')

    // Bind padding to the paired settlement app call; it cannot authorize any other group.
    const settlementTxn = gtxn.ApplicationCallTxn(0)
    assert(settlementTxn.appId === Application(HYBRID_APP_ID), 'Wrong hybrid application')
    assert(settlementTxn.numAppArgs === 3, 'Unexpected settlement arguments')
    assert(
      settlementTxn.appArgs(0) === op.sha512_256(Bytes('settleFromLogicSig(byte[],uint64)void')).slice(0, 4),
      'Wrong method',
    )
    assert(settlementTxn.appArgs(1) === CHANNEL_ID, 'Wrong channel')
    return true
  }
}
