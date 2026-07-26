# Release checklist

Release only from a `v*` tag. The Windows pipeline builds the panel, analyzer,
native effect, payload manifest, and installer, then publishes the stable
`AutoCutStudioSetup.exe` and `AutoCutStudio-CEP-Windows.zip` names.

The installer is unsigned unless a signing step is explicitly configured.
Only `native/MediaCore/AutoCutColorEngine.aex` is shipped; PDB, LIB, EXP, and
intermediate files are excluded.
