# Testing

Run `cargo fmt --all -- --check`, `cargo test --workspace`, and the workspace
Clippy gate from `.github/workflows/ci.yml` for the Rust boundary.

The panel uses Vitest for pure marker, analyzer-contract, and motion-preset
tests. With the current Node.js LTS installed, run `npm ci`, `npm test`, and
`npm run test:browser`. `npm run preview` serves the mocked Premiere bridge.

Native tests are built from production C++:

```text
cmake -S native/color-core -B native/color-core/build
cmake --build native/color-core/build --config Release
ctest --test-dir native/color-core/build -C Release
```

Premiere loading, CEP registration, and `.aex` render verification remain
release gates on a prepared Windows machine with Premiere Pro 2024–2026.
