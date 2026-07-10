import {
  Account,
  Application,
  Bytes,
  LogicSig,
  TemplateVar,
  Txn,
  assert,
  bytes,
  logicsig,
  op,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { falconVerify } from '@algorandfoundation/algorand-typescript/op'

/**
 * Template variables are supplied by the Kotlin client when it compiles one
 * LogicSig per channel. The resulting account can authorize only one hybrid
 * app-call shape, for one channel and one payee.
 */
const HYBRID_APP_ID = TemplateVar<uint64>('HYBRID_APP_ID')
const CHANNEL_ID = TemplateVar<bytes>('CHANNEL_ID')
const PAYEE = TemplateVar<Account>('PAYEE')
const AUTHORIZED_PUBLIC_KEY = TemplateVar<bytes>('AUTHORIZED_PUBLIC_KEY')

const ED25519_SIGNATURE_LENGTH: uint64 = 64
const ED25519_PUBLIC_KEY_LENGTH: uint64 = 32

/**
 * Arguments supplied when signing the application call with this LogicSig:
 *   arg 0: Falcon or Ed25519 signature over the domain-separated settlement voucher
 *   arg 1: cumulativeAmount encoded as an 8-byte unsigned integer
 *
 * `program()` validates the app call itself, so arguments cannot be replayed
 * against a different app, channel, recipient, or cumulative amount.
 */
@logicsig({ avmVersion: 12, name: 'EscrowSessionSettlementLogicSig' })
export class EscrowSessionSettlementLogicSig extends LogicSig {
  program(): boolean {
    assert(op.Global.groupSize === 1, 'Settlement must be a standalone transaction')
    assert(Txn.rekeyTo === Account(), 'Rekey not allowed')
    assert(Txn.applicationId === Application(HYBRID_APP_ID), 'Wrong hybrid application')
    assert(Txn.numAppArgs === 3, 'Unexpected settlement arguments')
    assert(Txn.applicationArgs(0) === op.sha512_256(Bytes('settleFromLogicSig(byte[],uint64)void')).slice(0, 4), 'Wrong method')
    assert(Txn.applicationArgs(1) === CHANNEL_ID, 'Wrong channel')

    const cumulativeAmount = op.extractUint64(op.arg(1), 0)
    assert(op.arg(1).length === 8, 'Amount argument must be uint64')
    assert(Txn.applicationArgs(2) === op.itob(cumulativeAmount), 'Amount argument mismatch')

    const message = op
      .itob(HYBRID_APP_ID)
      .concat(CHANNEL_ID)
      .concat(op.itob(cumulativeAmount))
      .concat(PAYEE.bytes)
      .concat(Bytes('settle-lsig-v1'))

    if (op.arg(0).length === ED25519_SIGNATURE_LENGTH) {
      assert(AUTHORIZED_PUBLIC_KEY.length === ED25519_PUBLIC_KEY_LENGTH, 'Ed25519 public key must be 32 bytes')
      return op.ed25519verifyBare(message, op.arg(0), AUTHORIZED_PUBLIC_KEY)
    }

    return falconVerify(message, op.arg(0), AUTHORIZED_PUBLIC_KEY)
  }
}
