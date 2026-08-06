package main

import (
	"encoding/base64"
	"fmt"
	"os"

	mobile "github.com/algorand/go-mobile-algorand-sdk/v2/sdk"
	"github.com/algorandfoundation/falcon-signatures/falcongo"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: falcon-voucher-sign <private-key-base64> <public-key-base64> <voucher-base64>")
		os.Exit(1)
	}
	privateKey, err := base64.StdEncoding.DecodeString(os.Args[1])
	if err != nil {
		panic(err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(os.Args[2])
	if err != nil {
		panic(err)
	}
	voucher, err := base64.StdEncoding.DecodeString(os.Args[3])
	if err != nil {
		panic(err)
	}
	signature, err := mobile.RawSign(voucher, publicKey, privateKey)
	if err != nil {
		panic(err)
	}
	var verifyKey falcongo.PublicKey
	copy(verifyKey[:], publicKey)
	if err := falcongo.Verify(voucher, signature, verifyKey); err != nil {
		panic(fmt.Errorf("deterministic Falcon signature self-verification failed: %w", err))
	}
	fmt.Print(base64.StdEncoding.EncodeToString(signature))
}
