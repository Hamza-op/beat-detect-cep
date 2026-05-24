# Native SDK

This folder contains the minimal Adobe SDK subset required to build the
AutoCutStudio native color plugin in CI.

The Visual Studio project references these paths directly:

- `native/sdk/Headers`
- `native/sdk/Headers/SP`
- `native/sdk/Headers/Win`
- `native/sdk/Resources`
- `native/sdk/Util`

`native/sdk/Resources/PiPLtool.exe` is required by the plugin resource build.
Keep it tracked as a binary file. Build outputs belong in `native/MediaCore`
or `native/premiere_plugin/Win/x64` and are intentionally ignored.
