# Native SDK

This folder contains the minimal Adobe SDK subset required to build the
AutoCutStudio native color plugin in CI.

The Visual Studio project references these paths directly:

- `vendor/adobe-sdk/Headers`
- `vendor/adobe-sdk/Headers/SP`
- `vendor/adobe-sdk/Headers/Win`
- `vendor/adobe-sdk/Resources`
- `vendor/adobe-sdk/Util`

`vendor/adobe-sdk/Resources/PiPLtool.exe` is required by the plugin resource build.
Keep it tracked as a binary file. Build outputs belong in `native/MediaCore`
or `native/premiere-plugin/Win/x64` and are intentionally ignored.

