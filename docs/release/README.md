# Release checklist

Release only from a `v*` tag. The Windows pipeline builds the panel, analyzer,
native effect, payload manifest, and installer, then publishes the stable
`AutoCutStudioSetup.exe` and `AutoCutStudio-CEP-Windows.zip` names.

Rolling builds are explicitly unsigned development installers. A stable tag
uses the production gate and is rejected unless the staged CEP payload is
signed, both native executables have valid Authenticode signatures, and the
installer certificate thumbprint is configured. Only
`native/MediaCore/AutoCutColorEngine.aex` is shipped; PDB, LIB, EXP, and
intermediate files are excluded.
