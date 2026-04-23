import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import { MppEscrowSessionVaultManagerFactory } from '../artifacts/mpp_escrow_session_vault_manager/MppEscrowSessionVaultManagerClient.ts'

export async function deploy() {
  console.log('=== Deploying MppEscrowSessionVaultManager ===')

  const algorand = AlgorandClient.fromEnvironment()

  const usdcAssetId = BigInt(process.env.TMPL_USDC_ASSET_ID ?? '10458941')

  if (!process.env.TMPL_USDC_ASSET_ID) {
    console.warn('TMPL_USDC_ASSET_ID not set; defaulting to 10458941 (TestNet USDC)')
  }

  console.log(`TMPL_USDC_ASSET_ID (compile-time): ${usdcAssetId.toString()}`)

  // This account becomes Global.creatorAddress (your admin in the current contract logic)
  const admin = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(MppEscrowSessionVaultManagerFactory, {
    defaultSender: admin.addr,
  })

  const { appClient, result } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    deployTimeParams: {
      USDC_ASSET_ID: usdcAssetId,
    },
  })


  console.log(`Operation: ${result.operationPerformed}`)
  console.log(`App ID: ${appClient.appClient.appId}L`)
  console.log(`App Address: ${appClient.appAddress}`)
  console.log(`Admin (creator): ${admin.addr}`)
  console.log(`USDC_ASSET_ID (from TMPL_USDC_ASSET_ID): ${usdcAssetId}`)

  // Fund app account after create/replace if needed for box usage, ASA holding MBR, and inner txns
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: admin.addr,
      receiver: appClient.appAddress,
    })
    console.log('Funded app account with 1 ALGO')
  } else {
    // Ensure enough ALGO for USDC opt-in MBR + inner tx fees on existing apps
    await algorand.send.payment({
      amount: microAlgo(300_000),
      sender: admin.addr,
      receiver: appClient.appAddress,
    })
    console.log('Topped up app account with 0.3 ALGO for opt-in/fees')
  }

  // Creator-only USDC opt-in for app account; safe to run each deploy
  try {
    await appClient.send.optInUsdc({
      sender: admin.addr,
      assetReferences: [usdcAssetId],
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(3_000),
    })
    console.log('App account opted into configured USDC ASA')
  } catch (e) {
    console.warn('optInUsdc skipped (possibly already opted-in or insufficient ALGO for MBR):', e)
  }
}
