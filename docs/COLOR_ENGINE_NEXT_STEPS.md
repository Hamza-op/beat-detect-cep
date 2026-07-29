# Color Engine Next Steps

The native color engine now supports 8-bpc, 16-bpc, and 32-bpc float render paths.

## Implemented

- 32-bpc `PF_PixelFloat` render support via `PF_OutFlag2_FLOAT_COLOR_AWARE`.
- ARGB128 registration through the Adobe pixel-format suite.
- Float-world detection through the Adobe pixel-data suite.
- HDR-preserving float correction math that keeps channel values above `1.0` instead of clipping highlights to SDR.
- Playhead-frame native analysis for the panel Auto Color workflow.
- Shared 8-bpc, 16-bpc, and 32-bpc correction kernel so bit-depth paths do not drift.
- Letterbox-aware frame statistics that ignore contiguous black bars without
  discarding genuinely dark footage.
- Conservative white-balance fallback that refuses to neutralize strongly
  saturated stage lighting when no neutral reference is present.
- Confidence-aware auto amount so clipped, low-light, or low-information frames
  receive a softer starting grade.

## Not Implemented Yet

### SIMD or GPU Acceleration

The effect still uses Adobe iterate suites with scalar per-pixel callbacks. A real SIMD/GPU upgrade should be a dedicated rendering-backend change, not a cosmetic compiler flag. The practical options are:

- CPU SIMD backend for the correction kernel, with AVX2 on Windows x64.
- Adobe GPU render path for Mercury Playback Engine-compatible acceleration.

### Temporal Smoothing

The current panel workflow intentionally captures one playhead frame and applies that fixed correction across the selected clip. Temporal smoothing or scene-adaptive grading would be a different editing model: multiple analysis points, interpolated values, and probably generated keyframes. It should not be mixed into the Auto button workflow unless a separate mode is added.
