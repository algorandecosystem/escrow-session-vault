import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import {
  LogicSigAccount,
  OnApplicationComplete,
  addressWithSignersFromRawFalcon1024Signer,
  decodeAddress,
  encodeUint64,
  assignGroupID,
  getApplicationAddress,
  makeApplicationCallTxnFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  pq25WordMnemonicToSeed,
  signLogicSigTransactionObject,
  FALCON_1024_SCHEME,
} from 'algosdk'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type FalconModule = typeof import('falcon-1024')

function loadFalcon(): FalconModule {
  // The PR-matched `falcon-1024@1.0.0-beta.2` package has a Node-compatible CJS export.
  // This deferred require keeps the runner compatible with the project’s CommonJS ts-node invocation.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('falcon-1024') as FalconModule
}

function falconAccount(falcon: FalconModule, mnemonic: string) {
  // Matches falcon-signatures-mobile v0.0.18's mnemonic.ToPQSeed(..., Falcon1024).
  const { publicKey, privateKey } = falcon.falcon1024.generateKey(
    pq25WordMnemonicToSeed(mnemonic, FALCON_1024_SCHEME),
  )
  return {
    ...addressWithSignersFromRawFalcon1024Signer({
      falcon1024PublicKey: publicKey,
      falcon1024Signer: async (bytesToSign) => falcon.falcon1024.signCompressed(privateKey, bytesToSign),
    }),
    publicKey,
    privateKey,
  }
}
function signAvmFalconVoucher(falcon: FalconModule, privateKey: Uint8Array, voucher: Uint8Array): Uint8Array {
  const signature = falcon.falcon1024.signCompressed(privateKey, voucher)
  if (signature[0] !== 0xba) throw new Error('Falcon signer did not produce an AVM deterministic signature')
  return signature
}

import { EscrowSessionVaultHybridManagerClient } from './artifacts/escrow_session_vault_hybrid_manager/EscrowSessionVaultHybridManagerClient'

const METHOD_SELECTOR = Uint8Array.from([0x43, 0x9c, 0x5f, 0xb1])
const CHANNEL_BOX_PREFIX = new Uint8Array()
const PUBLIC_KEY_BOX_PREFIX = new TextEncoder().encode('p')
const LOGIC_SIG_BOX_PREFIX = new TextEncoder().encode('l')
const NATIVE_FALCON_FEE = 3_000n
// Two outer LogicSig transactions and one inner ASA transfer need 3,000 microAlgos.
// Hardened LogicSig programs add 18 microAlgos of encoded-byte fee on Futurenet.
const LOGIC_SIG_SETTLEMENT_GROUP_FEE = 3_018n
const SETTLEMENT_COUNT = 3n
// The settlement LogicSig pays the pooled outer and inner-transfer fee; the padding LogicSig pays none.
const MIN_SETTLEMENT_LOGIC_SIG_FUNDING = microAlgo(
  100_000 + Number(LOGIC_SIG_SETTLEMENT_GROUP_FEE * SETTLEMENT_COUNT),
)
const MIN_PADDING_LOGIC_SIG_FUNDING = microAlgo(100_000)
// MBR added by each new channel's session, 1,793-byte Falcon public-key, and LogicSig boxes.
const CHANNEL_BOX_MBR_FUNDING = 835_900n

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function positiveBigInt(name: string): bigint {
  // Algorand tooling commonly displays IDs as e.g. `17794220L`; accept that display suffix in env files.
  const rawValue = required(name).trim()
  if (!/^\d+L?$/.test(rawValue)) throw new Error(`${name} must be a positive integer, optionally suffixed with L`)
  const value = BigInt(rawValue.replace(/L$/, ''))
  if (value <= 0n) throw new Error(`${name} must be greater than zero`)
  return value
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function sha512_256(value: Uint8Array): Uint8Array {
  return createHash('sha512-256').update(value).digest()
}

function formatDynamicData(data: readonly [bigint, bigint, bigint] | undefined): string {
  if (!data) return 'no return value'
  const [totalDeposit, lastSettled, latestVoucherAmount] = data
  return `totalDeposit=${totalDeposit}, lastSettled=${lastSettled}, latestVoucherAmount=${latestVoucherAmount}`
}

async function main(): Promise<void> {
  const appId = positiveBigInt('HYBRID_APP_ID')
  const usdcAssetId = positiveBigInt('USDC_ASSET_ID')
  const depositAmount = BigInt(process.env.DEPOSIT_AMOUNT ?? '1000000')
  const settlementAmount = BigInt(process.env.SETTLEMENT_AMOUNT ?? '400000')
  const finalSettlementAmount = settlementAmount * SETTLEMENT_COUNT
  if (depositAmount <= 0n || settlementAmount <= 0n || finalSettlementAmount > depositAmount) {
    throw new Error(`Require 0 < SETTLEMENT_AMOUNT * ${SETTLEMENT_COUNT} <= DEPOSIT_AMOUNT`)
  }

  const algorand = AlgorandClient.fromEnvironment()
  const falcon = loadFalcon()
  const payer = falconAccount(falcon, required('PAYER_MNEMONIC'))
  const payee = falconAccount(falcon, required('PAYEE_MNEMONIC'))
  const appClient = algorand.client.getTypedAppClientById(EscrowSessionVaultHybridManagerClient, {
    appId,
    defaultSender: payer.address,
  })
  const payerAddress = payer.address.toString()
  const payeeAddress = payee.address.toString()
  const expectedPayerAddress = process.env.PAYER_ADDRESS
  const expectedPayeeAddress = process.env.PAYEE_ADDRESS
  if (expectedPayerAddress && expectedPayerAddress !== payerAddress) {
    throw new Error(`PAYER_MNEMONIC derives ${payerAddress}, not configured PAYER_ADDRESS ${expectedPayerAddress}`)
  }
  if (expectedPayeeAddress && expectedPayeeAddress !== payeeAddress) {
    throw new Error(`PAYEE_MNEMONIC derives ${payeeAddress}, not configured PAYEE_ADDRESS ${expectedPayeeAddress}`)
  }
  const appAddress = getApplicationAddress(appId).toString()

  const authorizedSigner = sha512_256(payer.publicKey)
  const salt = randomBytes(32)
  // Must match contract.deriveChannelId(): sha256(payer || payee || assetId || salt || signerHash).
  const channelId = createHash('sha256').update(
    concat(
      decodeAddress(payerAddress).publicKey,
      decodeAddress(payeeAddress).publicKey,
      encodeUint64(usdcAssetId),
      salt,
      authorizedSigner,
    ),
  ).digest()

  console.log(`App: ${appId}`)
  console.log(`Payer: ${payerAddress}`)
  console.log(`Payee: ${payeeAddress}`)
  console.log(`Channel: ${Buffer.from(channelId).toString('hex')}`)

  // Each fresh channel creates session and Falcon public-key boxes, locking this MBR in the app account.
  // APP_BOX_MBR_FUNDING can add extra headroom when needed.
  const appBoxMbrFunding = CHANNEL_BOX_MBR_FUNDING + BigInt(process.env.APP_BOX_MBR_FUNDING ?? '0')
  if (appBoxMbrFunding > 0n) {
    await algorand.send.payment({
      sender: payer.address,
      signer: payer.txnSigner,
      receiver: appAddress,
      amount: microAlgo(appBoxMbrFunding),
      staticFee: microAlgo(NATIVE_FALCON_FEE),
    })
  }

  const deposit = await algorand.createTransaction.assetTransfer({
    sender: payer.address,
    receiver: appAddress,
    assetId: usdcAssetId,
    amount: depositAmount,
    staticFee: microAlgo(3_000),
  })
  await appClient.send.open({
    args: {
      payee: payeeAddress,
      deposit: { txn: deposit, signer: payer.txnSigner },
      salt,
      authorizedSigner,
      authorizedSignerPublicKey: payer.publicKey,
    },
    sender: payer.address,
    signer: payer.txnSigner,
    staticFee: microAlgo(3_000),
    boxReferences: [channelId, concat(PUBLIC_KEY_BOX_PREFIX, channelId)],
  })
  console.log('Opened channel and deposited USDC.')

  // Use the build artifact. The legacy `out/` copy was still AVM 12 and does not represent
  // the AVM 13 LogicSig source compiled by `npm run build`.
  const tealPath = resolve(__dirname, 'artifacts/escrow_session_vault_hybrid_manager/EscrowSessionSettlementLogicSig.teal')
  const tealTemplate = await readFile(tealPath, 'utf8')
  // ABI encodes a dynamic `byte[]` as a 2-byte length followed by its contents.
  // The raw channel ID remains the box key, while this form is passed to the app method.
  const encodedChannelId = concat(Uint8Array.from([0, channelId.length]), channelId)
  if (!tealTemplate.startsWith('#pragma version 13\n')) {
    throw new Error(`Expected an AVM 13 LogicSig artifact at ${tealPath}`)
  }
  const compiled = await algorand.app.compileTealTemplate(tealTemplate, {
    TMPL_HYBRID_APP_ID: appId,
    TMPL_CHANNEL_ID: encodedChannelId,
    TMPL_RAW_CHANNEL_ID: channelId,
    TMPL_PAYEE: decodeAddress(payeeAddress).publicKey,
    TMPL_AUTHORIZED_PUBLIC_KEY: payer.publicKey,
  })
  const compiledLogic = compiled.compiledBase64ToBytes
  if (!Buffer.from(compiledLogic).includes(Buffer.from(payer.publicKey))) {
    throw new Error('Compiled LogicSig does not contain the raw Falcon-1024 public key')
  }
  const logicSig = new LogicSigAccount(compiledLogic)
  const logicSigAddress = logicSig.address()

  await appClient.send.setSettlementLogicSig({
    args: { channelId, logicSig: logicSigAddress.toString() },
    sender: payer.address,
    signer: payer.txnSigner,
    staticFee: microAlgo(3_000),
    boxReferences: [channelId, concat(LOGIC_SIG_BOX_PREFIX, channelId)],
  })
  await algorand.send.payment({
    sender: payer.address,
    signer: payer.txnSigner,
    receiver: logicSigAddress,
    amount: MIN_SETTLEMENT_LOGIC_SIG_FUNDING,
    staticFee: microAlgo(3_000),
  })
  // Compile a constrained second LogicSig to pool another 1,000 bytes of LogicSig-argument capacity.
  const paddingTealPath = resolve(
    __dirname,
    'artifacts/escrow_session_vault_hybrid_manager/EscrowSessionSettlementPaddingLogicSig.teal',
  )
  const paddingTealTemplate = await readFile(paddingTealPath, 'utf8')
  if (!paddingTealTemplate.startsWith('#pragma version 13\n')) {
    throw new Error(`Expected an AVM 13 padding LogicSig artifact at ${paddingTealPath}`)
  }
  const paddingProgram = await algorand.app.compileTealTemplate(paddingTealTemplate, {
    TMPL_HYBRID_APP_ID: appId,
    TMPL_CHANNEL_ID: encodedChannelId,
  })
  const paddingLogicSig = new LogicSigAccount(paddingProgram.compiledBase64ToBytes)
  const paddingLogicSigAddress = paddingLogicSig.address()
  await algorand.send.payment({
    sender: payer.address,
    signer: payer.txnSigner,
    receiver: paddingLogicSigAddress,
    amount: MIN_PADDING_LOGIC_SIG_FUNDING,
    staticFee: microAlgo(3_000),
  })
  console.log(`Registered and funded LogicSig: ${logicSigAddress}`)

  const beforeSettlement = await appClient.send.getSessionDynamicData({
    args: { channelId },
    sender: payee.address,
    signer: payee.txnSigner,
    staticFee: microAlgo(3_000),
    boxReferences: [channelId],
  })
  console.log(`Balances after open: ${formatDynamicData(beforeSettlement.return)}`)

  for (let settlementIndex = 1n; settlementIndex <= SETTLEMENT_COUNT; settlementIndex++) {
    const cumulativeAmount = settlementAmount * settlementIndex
    const voucher = concat(
      encodeUint64(appId),
      channelId,
      encodeUint64(cumulativeAmount),
      decodeAddress(payeeAddress).publicKey,
      new TextEncoder().encode('settle-lsig-v1'),
    )
    const signature = signAvmFalconVoucher(falcon, payer.privateKey, voucher)
    if (!falcon.falcon1024.verifyCompressed(payer.publicKey, signature, voucher)) {
      throw new Error('AVM Falcon voucher failed cross-library verification')
    }

    const settlementParams = await algorand.client.algod.getTransactionParams().do()
    settlementParams.fee = LOGIC_SIG_SETTLEMENT_GROUP_FEE
    settlementParams.flatFee = true
    const paddingParams = await algorand.client.algod.getTransactionParams().do()
    paddingParams.fee = 0n
    paddingParams.flatFee = true
    const settlementTxn = makeApplicationCallTxnFromObject({
      sender: logicSigAddress,
      appIndex: appId,
      onComplete: OnApplicationComplete.NoOpOC,
      appArgs: [METHOD_SELECTOR, encodedChannelId, encodeUint64(cumulativeAmount)],
      accounts: [payeeAddress],
      boxes: [
        { appIndex: 0, name: channelId },
        { appIndex: 0, name: concat(LOGIC_SIG_BOX_PREFIX, channelId) },
      ],
      foreignAssets: [usdcAssetId],
      suggestedParams: settlementParams,
    })
    const paddingTxn = makePaymentTxnWithSuggestedParamsFromObject({
      sender: paddingLogicSigAddress,
      receiver: paddingLogicSigAddress,
      amount: 0,
      suggestedParams: paddingParams,
    })
    assignGroupID([settlementTxn, paddingTxn])
    logicSig.lsig.args = [signature, encodeUint64(cumulativeAmount)]
    const signedSettlement = signLogicSigTransactionObject(settlementTxn, logicSig)
    const signedPadding = signLogicSigTransactionObject(paddingTxn, paddingLogicSig)
    await algorand.client.algod.sendRawTransaction([signedSettlement.blob, signedPadding.blob]).do()
    await algorand.client.algod.pendingTransactionInformation(signedSettlement.txID).do()
    console.log(`Settlement ${settlementIndex}/${SETTLEMENT_COUNT}: cumulative=${cumulativeAmount} USDC`)
    console.log(`Settlement transaction ID: ${signedSettlement.txID}`)
    console.log(`FNet explorer: https://lora.algokit.io/fnet/transaction/${signedSettlement.txID}`)
  }

  const afterSettlement = await appClient.send.getSessionDynamicData({
    args: { channelId },
    sender: payee.address,
    signer: payee.txnSigner,
    staticFee: microAlgo(NATIVE_FALCON_FEE),
    boxReferences: [channelId],
  })
  console.log(`Balances after three settlements: ${formatDynamicData(afterSettlement.return)}`)

  if (process.env.CLOSE_AFTER_SETTLEMENT === 'true') {
    await appClient.send.close({
      args: { channelId },
      sender: payee.address,
      signer: payee.txnSigner,
      staticFee: microAlgo(6_000),
      assetReferences: [usdcAssetId],
      boxReferences: [
        channelId,
        concat(PUBLIC_KEY_BOX_PREFIX, channelId),
        concat(LOGIC_SIG_BOX_PREFIX, channelId),
      ],
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(6_000),
    })
    console.log('Closed channel as payee; remaining USDC was refunded to payer.')
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
