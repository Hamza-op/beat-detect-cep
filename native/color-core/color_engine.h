#ifndef COLOR_ENGINE_H
#define COLOR_ENGINE_H

/*
 * Color analysis interface.
 *
 * Requires C++11 or later.
 * Compatible with the existing ColorEngine implementation.
 *
 * Field order and method signatures are intentionally preserved.
 * Rebuild dependent code when changing this header; this structure is not
 * a portable serialization format or a versioned binary interface.
 */

struct FrameAnalysisResult {
    /*
     * Exposure correction in the engine's native control units.
     * The current analyzer produces approximately -0.90 to +0.95.
     * This is not a -150..150 slider value or a calibrated EV measurement.
     * Any UI or renderer conversion must be defined by the caller.
     */
    float exposure = 0.0f;

    // Tonal adjustments. Zero is neutral.
    float contrast = 0.0f;       // Nominal control range: -100..100.
    float highlights = 0.0f;     // Nominal control range: -100..100.
    float shadows = 0.0f;        // Nominal control range: -100..100.
    float whites = 0.0f;         // Nominal control range: -100..100.
    float blacks = 0.0f;         // Nominal control range: -100..100.

    float saturation = 100.0f;   // 0..200; 100 is neutral.

    // White balance and color adjustments. Zero is neutral.
    float temperature = 0.0f;    // -100..100; not degrees Kelvin.
    float tint = 0.0f;           // -100..100.
    float vibrance = 0.0f;       // -100..100.

    // Split-tone adjustments. Zero is neutral.
    float shadows_temp = 0.0f;   // -100..100.
    float shadows_tint = 0.0f;   // -100..100.
    float highlights_temp = 0.0f;// -100..100.
    float highlights_tint = 0.0f;// -100..100.

    /*
     * Heuristic evidence score in 0..1.
     * Not a calibrated probability that the proposed correction is correct.
     * A successful analysis can return zero confidence and neutral controls.
     */
    float confidence = 0.0f;

    /*
     * Indicates a Log-like tonal distribution only.
     * Does not identify a camera profile, transfer function, or input LUT.
     */
    bool is_log = false;

    /*
     * Indicates a dark tonal distribution.
     * Does not prove that the scene was unintentionally underexposed.
     */
    bool is_low_light = false;
};

/*
 * Stateless frame analyzer.
 *
 * Shared input contract:
 *
 * - Four packed channels per pixel, in RGBA order.
 * - RGB must be straight/unassociated, not premultiplied.
 * - Width and height must be positive.
 * - row_bytes is a signed byte stride, including any row padding.
 * - Negative stride is supported: pixel_buffer must point to logical row zero.
 * - The absolute stride must accommodate an entire packed pixel row.
 * - The caller owns the buffer and must keep it readable and unchanged for
 *   the duration of the call.
 * - The API cannot verify allocation bounds because no buffer size is supplied.
 * - The current implementation supports unaligned channel storage via memcpy.
 *
 * Color interpretation:
 *
 * - Thresholds are calibrated for display-referred SDR RGB.
 * - No transfer function, color profile, or channel layout is inferred.
 * - Convert BGRA/ARGB, premultiplied, linear, Log, PQ, or HLG input to the
 *   appropriate analysis representation before calling when necessary.
 * - Nearly transparent pixels and pixels with non-finite float components
 *   are excluded from analysis.
 * - Dark edge trimming is heuristic and may resemble naturally dark content.
 *
 * Return contract:
 *
 * - true: result was replaced with a completed analysis.
 * - false: result is unchanged.
 * - A valid but nearly uniform frame may succeed with neutral corrections
 *   and zero confidence.
 * - A frame with no usable pixels fails.
 *
 * Concurrency:
 *
 * The implementation keeps no mutable per-instance analysis state. Concurrent
 * calls may share an engine instance, provided each call has its own result
 * object and the input buffers are not modified concurrently.
 *
 * Methods deliberately retain their existing non-const, non-static signatures
 * to match color_engine.cpp. Do not add noexcept without updating and auditing
 * the corresponding definitions.
 */
class ColorEngine {
public:
    ColorEngine() = default;
    ~ColorEngine() = default;

    /*
     * Packed RGBA with four unsigned 8-bit channels per pixel.
     * Channel range: 0..255. Fully opaque alpha: 255.
     */
    bool AnalyzeFrame8(
        const unsigned char* pixel_buffer,
        int width,
        int height,
        int row_bytes,
        FrameAnalysisResult& result
    );

    /*
     * Packed RGBA with four native-endian unsigned 16-bit channels per pixel.
     * Channel range: 0..65535. Fully opaque alpha: 65535.
     *
     * Adobe formats using 0..32768 require caller-side conversion.
     */
    bool AnalyzeFrame16(
        const unsigned short* pixel_buffer,
        int width,
        int height,
        int row_bytes,
        FrameAnalysisResult& result
    );

    /*
     * Packed RGBA with four IEEE-754 32-bit float channels per pixel.
     * Nominal RGB range: 0..1. Fully opaque alpha: 1.
     *
     * The current implementation clamps negative RGB values to zero.
     * Significant super-white content uses a bounded analysis proxy and
     * receives restricted recommendations; this is not an HDR color transform.
     */
    bool AnalyzeFrame32(
        const float* pixel_buffer,
        int width,
        int height,
        int row_bytes,
        FrameAnalysisResult& result
    );
};

#endif // COLOR_ENGINE_H