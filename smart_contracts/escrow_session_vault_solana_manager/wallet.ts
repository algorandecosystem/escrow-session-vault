import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { mnemonicToSeedSync, validateMnemonic } from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'

export async function keypair(path: string): Promise<Keypair> {
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path)
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(expanded, 'utf8')) as number[]))
}

// Restores SOLANA_{PAYER,PAYEE} from *_PRIVATE_KEY, *_MNEMONIC, or *_KEYPAIR. Never logs secrets.
// Mnemonics use m/44'/501'/index' (payer index 1, payee index 0) unless overridden.
// When SOLANA_{ROLE}_ADDRESS is set, the restored key must match it.
export async function environmentWallet(role: 'PAYER' | 'PAYEE'): Promise<Keypair> {
  const prefix = `SOLANA_${role}`
  const expected = process.env[`${prefix}_ADDRESS`]
  const secret = process.env[`${prefix}_PRIVATE_KEY`]
  const mnemonic = process.env[`${prefix}_MNEMONIC`]
  let wallet: Keypair
  if (secret) {
    // Accept a base58 64-byte secret or Solana CLI's JSON byte array.
    const bytes = secret.trim().startsWith('[')
      ? Uint8Array.from(JSON.parse(secret) as number[]) : bs58.decode(secret.trim())
    wallet = Keypair.fromSecretKey(bytes)
  } else if (mnemonic) {
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
    const valid = validateMnemonic(normalized)
    if (!valid && process.env.SOLANA_ALLOW_INVALID_MNEMONIC !== 'true') {
      throw new Error(`${prefix}_MNEMONIC has an invalid BIP39 checksum. Set SOLANA_ALLOW_INVALID_MNEMONIC=true to restore it anyway.`)
    }
    const index = process.env[`${prefix}_ACCOUNT_INDEX`] ?? (role === 'PAYER' ? '1' : '0')
    if (!/^\d+$/.test(index) || BigInt(index) >= 2n ** 31n) throw new Error(`${prefix}_ACCOUNT_INDEX is invalid`)
    // This wallet uses the three-component hardened path, not Phantom's trailing /0'.
    const path = process.env[`${prefix}_DERIVATION_PATH`] ?? `m/44'/501'/${index}'`
    const seed = mnemonicToSeedSync(normalized, process.env.SOLANA_MNEMONIC_PASSPHRASE ?? '')
    wallet = Keypair.fromSeed(derivePath(path, seed.toString('hex')).key)
    if (!valid) {
      console.warn(`${role}: restored checksum-invalid words via ${path} -> ${wallet.publicKey.toBase58()}`
        + (expected ? '' : ` (set ${prefix}_ADDRESS to enforce this address)`))
    }
  } else {
    const path = process.env[`${prefix}_KEYPAIR`] ?? (role === 'PAYER'
      ? process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json' : undefined)
    if (!path) throw new Error(`Provide ${prefix}_MNEMONIC, ${prefix}_PRIVATE_KEY, or ${prefix}_KEYPAIR`)
    wallet = await keypair(path)
  }
  if (expected && wallet.publicKey.toBase58() !== expected) {
    throw new Error(`${role} derives ${wallet.publicKey.toBase58()}, not configured address ${expected}`)
  }
  return wallet
}

// Public devnet RPC rate-limits deploys/tests heavily; prefer Helius when a key is configured.
export function devnetRpc(): { url: string, label: string } {
  const heliusKey = process.env.SOLANA_HELIUS_API_KEY?.trim()
  const url = process.env.SOLANA_RPC_URL ?? (heliusKey
    ? `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`
    : 'https://api.devnet.solana.com')
  return { url, label: redact(url) }
}

export function redact(text: string): string {
  return text.replace(/api-key=[^&\s"']+/g, 'api-key=[redacted]')
}
