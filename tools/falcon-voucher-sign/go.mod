module falcon-voucher-sign

go 1.25.0

require (
	github.com/algorand/go-mobile-algorand-sdk/v2 v2.0.0-20260804233036-6fba88a4a5e6
	github.com/algorandfoundation/falcon-signatures v1.1.2
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/algorand/avm-abi v0.2.0 // indirect
	github.com/algorand/falcon v0.1.0 // indirect
	github.com/algorand/go-algorand-sdk/v2 v2.11.2-0.20260803154032-1140621b04db // indirect
	github.com/algorand/go-codec/codec v1.1.10 // indirect
	github.com/google/go-querystring v1.1.0 // indirect
	golang.org/x/crypto v0.45.0 // indirect
	golang.org/x/text v0.31.0 // indirect
)

replace github.com/algorand/go-mobile-algorand-sdk/v2 => ../falcon-address-parity/falcon-signatures-mobile
