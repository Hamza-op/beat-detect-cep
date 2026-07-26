# Troubleshooting

If a panel is not visible, enable only the relevant `CSXS.11`, `CSXS.12`, or
`CSXS.13` `PlayerDebugMode` value and restart Premiere. Diagnostics reports
selection identity, marker APIs, QE availability, native effect discovery,
and analysis-status support.

Warp Stabilizer stops when Premiere cannot report analysis status. This is
intentional: the queue never applies the next effect blindly. Motion Clear
only touches AutoCutStudio Transform components and preserves built-in Motion
keys. Color Reset only disables the exact AutoCutStudio Color Engine instance.
