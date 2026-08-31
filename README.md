# escrow-session-vault

This project is an escrow session vault inspired by [https://paymentauth.org/draft-tempo-session-00#name-contract-functions](https://paymentauth.org/draft-tempo-session-00#name-contract-functions).

## Escrow Session Vault

futurenet app id: 17794007L

futurenet app address: XYDZ7A3PL2PSSM3FLATB2ZX5ACOCGMOQGHOS3S7HT2NYPOJ6K27NESS4XY

testnet app id: 766375249L 

testnet app address: 3VPDN27EUFKI3M7W2RTHNUMP7OF6H6EHON4RW7CPFO6OJDCHYT2F5RXGM4

mainnet app id: 3617483943L

mainnet app address: 26XC5GSRN42CGA4JTX5GQULHONBTWGHIABRY3R4L6ZI3YPXRZIPN3BXDMQ

## Escrow Hybrid Session Vault

futurenet app id: 18086245L

futurenet app address: AGJFWTU2P5YWFRVMXTKXGFW4ELJK7VGBPQRUP6ZV66X7KZ6XENFEVNK36Q

testnet app id: 770746572L

testnet app address: 24DZUPT3BBAO7N7KY7OCGSFFCTVXMHUCOVP3WEEFZEEMKKOO3H4AZIPPVU

mainnet app id: 3689924545L

mainnet app address: D3Q3EXWL7HSVSA6GMWUQLQTEPPWDDS3NN6GFZYT2UV2GN34PRIDBYHKEZE

(These are not audited or verified and are for demonstration purposes only)

# Setup

### Pre-requisites

- [Nodejs 22](https://nodejs.org/en/download) or later
- [AlgoKit CLI 2.5](https://github.com/algorandfoundation/algokit-cli?tab=readme-ov-file#install) or later
- [Puya Compiler 4.4.4](https://pypi.org/project/puyapy/) or later

### Generate '.env' files

By default the template instance does not contain any env files to deploy to different networks. Using [`algokit project deploy`](https://github.com/algorandfoundation/algokit-cli/blob/main/docs/features/project/deploy.md) against `localnet` | `testnet` | `mainnet` will use default values for `algod` and `indexer` unless overwritten via `.env` or `.env.{target_network}`.

To generate a new `.env` or `.env.{target_network}` file, run `algokit generate env-file`

### Deploying Smart Contracts

### Deploying the Escrow Session Vault

```javascript
algokit compile ts ./smart_contracts/escrow_session_vault_manager/contract.algo.ts
npm run deploy:futurenet -- escrow_session_vault_manager
npm run deploy:testnet -- escrow_session_vault_manager
npm run deploy:mainnet -- escrow_session_vault_manager
```

### Deploying the Escrow Hybrid Session Vault

The hybrid implementation is a separate application in `smart_contracts/escrow_session_vault_hybrid_manager`; it does not modify or upgrade the original vault. Build artifacts include the application and `EscrowSessionSettlementLogicSig.teal`.

```bash
algokit compile ts ./smart_contracts/escrow_session_vault_hybrid_manager/contract.algo.ts
npm run build
npm run deploy:futurenet -- escrow_session_vault_hybrid_manager
npm run deploy:testnet -- escrow_session_vault_hybrid_manager
npm run deploy:mainnet -- escrow_session_vault_hybrid_manager
```

#### Creating and Registering a Channel LogicSig

A LogicSig is **not deployed on-chain**. The Kotlin client compiles one LogicSig locally for every new channel from `EscrowSessionSettlementLogicSig.teal` (or the TypeScript source) and uses its derived address as the account that authorizes settlements.

Compile it after the hybrid app has been deployed, supplying these template values:

- **`HYBRID_APP_ID`**: newly deployed hybrid application ID.
- **`CHANNEL_ID`**: the ID returned/derived when opening this channel.
- **`PAYEE`**: the channel payee Algorand address.
- **`AUTHORIZED_PUBLIC_KEY`**: payer's voucher-signing public key.

Then perform these steps from Kotlin:

1. Open the hybrid channel, supplying `authorizedSigner = sha512_256(authorizedPublicKey)` and the full `authorizedSignerPublicKey`.
2. Compile the per-channel LogicSig and obtain its address.
3. Call `setSettlementLogicSig(channelId, logicSigAddress)` from the payer account.
4. Fund the LogicSig address with ALGO for its outer application-call fee and the app's inner USDC transfer fee.

For settlement, the payee creates an application call to `settleFromLogicSig(channelId, cumulativeAmount)` and signs that transaction with the compiled LogicSig. It supplies LogicSig arguments—not application arguments—for the voucher:

- **LogicSig arg 0**: payer's voucher signature.
- **LogicSig arg 1**: `cumulativeAmount` encoded as exactly 8 big-endian bytes.

The LogicSig verifies the voucher before authorizing the app call. The hybrid app then transfers `cumulativeAmount - lastSettled` USDC to the payee and atomically advances `lastSettled` and `latestVoucherAmount`, preventing replay.

#### Voucher Signature Compatibility

- **Ed25519**: supported on current networks. Use a 32-byte public key and a 64-byte *bare* Ed25519 signature over the domain-separated message constructed by the LogicSig. This is not an Algorand transaction signature.
- **Falcon**: the LogicSig source supports Falcon verification, but a Falcon public key can be up to 1,793 bytes and is embedded in the compiled LogicSig through `AUTHORIZED_PUBLIC_KEY`. This exceeds the current normal standalone LogicSig program allowance. Use app-box Falcon verification until the network activates and you validate the proposed large-LogicSig program feature.

### Debugging Smart Contracts

This project is optimized to work with AlgoKit AVM Debugger extension. To activate it:

Refer to the commented header in the `index.ts` file in the `smart_contracts` folder.Since you have opted in to include VSCode launch configurations in your project, you can also use the `Debug TEAL via AlgoKit AVM Debugger` launch configuration to interactively select an available trace file and launch the debug session for your smart contract.

For information on using and setting up the `AlgoKit AVM Debugger` VSCode extension refer [here](https://github.com/algorandfoundation/algokit-avm-vscode-debugger). To install the extension from the VSCode Marketplace, use the following link: [AlgoKit AVM Debugger extension](https://marketplace.visualstudio.com/items?itemName=algorandfoundation.algokit-avm-vscode-debugger).

# Tools

This project makes use of Algorand TypeScript to build Algorand smart contracts. The following tools are in use:

- [Algorand](https://www.algorand.com/) - Layer 1 Blockchain; [Developer portal](https://dev.algorand.co/), [Why Algorand?](https://dev.algorand.co/getting-started/why-algorand/)
- [AlgoKit](https://github.com/algorandfoundation/algokit-cli) - One-stop shop tool for developers building on the Algorand network; [docs](https://github.com/algorandfoundation/algokit-cli/blob/main/docs/algokit.md), [intro tutorial](https://github.com/algorandfoundation/algokit-cli/blob/main/docs/tutorials/intro.md)
- [Algorand TypeScript](https://github.com/algorandfoundation/puya-ts/) - A semantically and syntactically compatible, typed TypeScript language that works with standard TypeScript tooling and allows you to express smart contracts (apps) and smart signatures (logic signatures) for deployment on the Algorand Virtual Machine (AVM); [docs](https://github.com/algorandfoundation/puya-ts/), [examples](https://github.com/algorandfoundation/puya-ts/tree/main/examples)
- [NPM](https://www.npmjs.com/): TypeScript packaging and dependency management.
- [TypeScript](https://www.typescriptlang.org/): Strongly typed programming language that builds on JavaScript
- [ts-node-dev](https://github.com/wclr/ts-node-dev): TypeScript development execution environment


