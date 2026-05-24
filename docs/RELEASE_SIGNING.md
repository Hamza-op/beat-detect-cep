# Release Signing

AutoCut Studio can build local development installers without a code-signing certificate, but production releases must be signed.

## Required Signing Assets

- Windows Authenticode code-signing certificate from a trusted CA.
- Secure certificate storage, preferably an HSM-backed or cloud signing flow.
- Timestamping URL from the certificate provider.

## Production Gate

Before publishing a release:

1. Build the native color plugin and installer from a clean tree.
2. Sign `AutoCutColorEngine.aex`.
3. Sign `beat_analyzer.exe`.
4. Sign `AutoCutStudioSetup.exe`.
5. Verify signatures with `Get-AuthenticodeSignature`.
6. Install on a clean Windows machine with Premiere Pro and confirm the CEP panel, Rust analyzer, and native color engine load without unsigned-binary prompts.

Unsigned binaries are acceptable only for local development builds.
