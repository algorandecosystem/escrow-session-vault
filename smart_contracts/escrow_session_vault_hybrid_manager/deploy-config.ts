import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import { EscrowSessionVaultHybridManagerFactory } from '../artifacts/escrow_session_vault_hybrid_manager/EscrowSessionVaultHybridManagerClient'

export async function deploy() {
  console.log('=== Deploying EscrowSessionVaultHybridManager ===')

  const algorand = AlgorandClient.fromEnvironment()
  const usdcAssetId = BigInt(process.env.TMPL_USDC_ASSET_ID ?? '10458941')
  const admin = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(EscrowSessionVaultHybridManagerFactory, {
    defaultSender: admin.addr,
  })

  const { appClient, result } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    deployTimeParams: { USDC_ASSET_ID: usdcAssetId },
  })

  console.log(`Operation: ${result.operationPerformed}`)
  console.log(`Hybrid app ID: ${appClient.appClient.appId}L`)
  console.log(`Hybrid app address: ${appClient.appAddress}`)

  await algorand.send.payment({
    amount: ['create', 'replace'].includes(result.operationPerformed) ? (1).algo() : microAlgo(300_000),
    sender: admin.addr,
    receiver: appClient.appAddress,
  })

  try {
    await appClient.send.optInUsdc({
      args: [],
      sender: admin.addr,
      assetReferences: [usdcAssetId],
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(3_000),
    })
  } catch (error) {
    console.warn('optInUsdc skipped (already opted in or requires additional funding):', error)
  }
}
