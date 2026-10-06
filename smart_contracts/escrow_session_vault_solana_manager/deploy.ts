import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { devnetRpc, environmentWallet, keypair, redact } from './wallet'

// Build + deploy (or upgrade) the program to devnet, like Algorand's deploy:testnet.
//   npm run deploy:devnet          (root: npm run deploy:solana:devnet)
// The payer from ../../.env.testnet pays rent and becomes the upgrade authority.
// Skips the upload when the on-chain bytes already match the build, so reruns cost nothing.
// SKIP_BUILD=true reuses target/deploy/*.so. SOLANA_TOOLS_DIR points at Anchor/Agave if not on PATH.
// Mainnet is intentionally unsupported here: it needs a `--features mainnet` build and an explicit opt-in.

const PROGRAM = 'escrow_session_vault_solana_manager'
const SBF_TOOLS_VERSION = 'v1.52'
// UpgradeableLoaderState::ProgramData header: 4-byte tag + 8-byte slot + 1-byte option + 32-byte authority.
const PROGRAM_DATA_HEADER = 45

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // Commands may echo the RPC URL; redact the API key from every line.
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(redact(chunk.toString())))
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(redact(chunk.toString())))
    child.on('error', fail)
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${command} ${args[0]} exited with ${code}`))))
  })
}

function addToolsToPath(): void {
  const dir = process.env.SOLANA_TOOLS_DIR ?? join(homedir(), '.local/share/mpp-solana-build-tools')
  const extra = [join(dir, 'bin'), join(dir, 'solana-release/bin')].filter(existsSync)
  process.env.PATH = [...extra, process.env.PATH ?? ''].join(delimiter)
}

async function anchorProgramId(root: string): Promise<string> {
  const toml = await readFile(join(root, 'Anchor.toml'), 'utf8')
  const match = toml.match(/\[programs\.devnet\][^[]*?escrow_session_vault_solana_manager\s*=\s*"(\w+)"/)
  if (!match) throw new Error('Anchor.toml has no [programs.devnet] entry')
  return match[1]
}

async function main(): Promise<void> {
  const root = __dirname
  const soPath = join(root, 'target/deploy', `${PROGRAM}.so`)
  const programKeypairPath = join(root, 'target/deploy', `${PROGRAM}-keypair.json`)
  addToolsToPath()

  if (!existsSync(programKeypairPath)) {
    throw new Error(`Missing ${programKeypairPath}. This key fixes the program address; restore it before deploying.`)
  }
  const programId = (await keypair(programKeypairPath)).publicKey
  const configuredId = await anchorProgramId(root)
  if (programId.toBase58() !== configuredId) {
    throw new Error(`Program keypair is ${programId}, but Anchor.toml/declare_id use ${configuredId}. Run anchor keys sync.`)
  }

  const payer = await environmentWallet('PAYER')
  const { url: rpc, label } = devnetRpc()
  const connection = new Connection(rpc, 'confirmed')
  const genesis = await connection.getGenesisHash()
  // Devnet genesis hash; refuses to spend funds if the RPC actually points at mainnet/testnet.
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error(`${label} is not devnet`)
  console.log(`RPC: ${label}\nProgram: ${programId}\nDeployer/upgrade authority: ${payer.publicKey}`)

  if (process.env.SKIP_BUILD !== 'true') {
    // Never add local-testing here: it disables the USDC mint allowlist.
    // Anchor forwards `--` args to the IDL step too, which rejects --tools-version; build them separately.
    await run('anchor', ['build', '--no-idl', '--', '--tools-version', SBF_TOOLS_VERSION], root)
    await run('anchor', ['idl', 'build', '-o', join(root, 'target/idl', `${PROGRAM}.json`)], root)
  }
  const binary = await readFile(soPath)

  const program = await connection.getAccountInfo(programId)
  let required = 2 * (await connection.getMinimumBalanceForRentExemption(binary.length + PROGRAM_DATA_HEADER))
  if (program) {
    const programData = new PublicKey(program.data.subarray(4, 36))
    const data = (await connection.getAccountInfo(programData))?.data
    if (!data) throw new Error(`Program data account ${programData} is missing`)
    const authority = data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null
    if (!authority?.equals(payer.publicKey)) {
      throw new Error(`Upgrade authority is ${authority ?? 'none (immutable)'}, not the payer ${payer.publicKey}`)
    }
    const deployed = data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + binary.length)
    const trailing = data.subarray(PROGRAM_DATA_HEADER + binary.length)
    if (deployed.equals(binary) && trailing.every((byte) => byte === 0)) {
      console.log('Deployed program already matches this build; nothing to upload.')
      return
    }
    // Upgrades stage the new binary in a temporary buffer (refunded on success).
    required = await connection.getMinimumBalanceForRentExemption(binary.length + 37)
  }
  const balance = await connection.getBalance(payer.publicKey)
  const needed = required + 0.05 * LAMPORTS_PER_SOL // headroom for ~300 upload transaction fees
  console.log(`Binary: ${binary.length} bytes; payer balance ${balance / LAMPORTS_PER_SOL} SOL; needs ~${needed / LAMPORTS_PER_SOL} SOL`)
  if (balance < needed) throw new Error('Payer does not have enough SOL to deploy')

  // The Solana CLI only signs with key files, so write one to a private temp dir and always delete it.
  const dir = await mkdtemp(join(tmpdir(), 'solana-deploy-'))
  const payerPath = join(dir, 'payer.json')
  const cleanup = (): void => { void rm(dir, { recursive: true, force: true }) }
  process.once('SIGINT', () => { cleanup(); process.exit(130) })
  try {
    await chmod(dir, 0o700)
    await writeFile(payerPath, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 })
    await run('solana', [
      'program', 'deploy', soPath,
      '--program-id', programKeypairPath,
      '--keypair', payerPath,
      '--upgrade-authority', payerPath,
      '--url', rpc,
      '--use-rpc', // send through the (Helius) RPC instead of validator TPU ports
      '--max-sign-attempts', '50',
    ], root)
  } catch (error) {
    console.error('Deploy failed. If a buffer was left behind, reclaim its SOL with:\n'
      + `  solana program show --buffers -u devnet --buffer-authority ${payer.publicKey}\n`
      + '  solana program close <BUFFER> -u devnet')
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  console.log(`Deployed ${programId} to devnet.`)
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
