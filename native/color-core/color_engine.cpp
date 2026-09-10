#include "color_engine.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>
#include <vector>

namespace {

/*
 * Input contract:
 *
 * - Packed RGBA, with four channels per pixel.
 * - RGB must be straight/unassociated, not premultiplied.
 * - AnalyzeFrame8:  channels use 0..255.
 * - AnalyzeFrame16: channels use the full unsigned 16-bit range, 0..65535.
 *   Adobe formats using 0..32768 must be converted by the caller.
 * - AnalyzeFrame32: normalized float RGB, nominally 0..1.
 * - Integer channels use native byte order.
 * - row_bytes may be negative. pixel_buffer must point to logical row zero,
 *   with every addressed row inside the caller-owned allocation.
 *
 * The API has no buffer-length argument, so allocation bounds cannot be
 * verified here. The caller must provide a valid, readable buffer.
 *
 * Tone thresholds are calibrated for display-referred SDR RGB. These
 * functions do not infer a transfer function, camera profile, or color space.
 * Linear, Log, PQ, and HLG footage should be converted to an appropriate
 * analysis space by the caller.
 *
 * Float super-whites receive a bounded, hue-preserving analysis proxy.
 * This is not an HDR-to-SDR color transform. Recommendations are intentionally
 * restricted when this proxy is used.
 *
 * On failure, the caller's result is left unchanged.
 */

using Count = std::uint64_t;
using Histogram = std::array<Count, 256>;

constexpr double kAlphaThreshold = 3.0 / 255.0;
constexpr double kDarkThreshold = 10.0 / 255.0;
constexpr double kBarFraction = 0.97;
constexpr double kMinimumContentFraction = 0.20;

constexpr double kSuperWhiteThreshold = 1.02;
constexpr double kSignificantSuperWhiteFraction = 0.01;
constexpr double kMaximumAnalysisHeadroom = 16.0;
constexpr std::size_t kHeadroomBins = 512;

struct AnalysisBounds {
    int left;
    int top;
    int right;
    int bottom;
};

struct Pixel {
    double r;
    double g;
    double b;
    double a;
};

struct FloatMapping {
    bool compress_headroom = false;
    double analysis_white = 1.0;
    double super_white_fraction = 0.0;
};

struct FrameStatistics {
    Histogram luma_histogram{};
    Histogram r_histogram{};
    Histogram g_histogram{};
    Histogram b_histogram{};

    Count count = 0;
    Count rejected_count = 0;
    Count mid_count = 0;
    Count neutral_count = 0;
    Count skin_count = 0;

    double r_sum = 0.0;
    double g_sum = 0.0;
    double b_sum = 0.0;

    double luma_sum = 0.0;
    double luma_squared_sum = 0.0;
    double saturation_sum = 0.0;

    double mid_r_sum = 0.0;
    double mid_g_sum = 0.0;
    double mid_b_sum = 0.0;

    double neutral_r_sum = 0.0;
    double neutral_g_sum = 0.0;
    double neutral_b_sum = 0.0;

    double skin_r_sum = 0.0;
    double skin_g_sum = 0.0;
};

template <typename T>
T Clamp(T value, T minimum, T maximum)
{
    return std::max(minimum, std::min(maximum, value));
}

float ToFloat(double value)
{
    return static_cast<float>(value);
}

double Rec709Luma(double r, double g, double b)
{
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

double ApplyDeadZone(double value, double dead_zone)
{
    if (std::fabs(value) <= dead_zone) {
        return 0.0;
    }

    return value > 0.0 ? value - dead_zone : value + dead_zone;
}

double Fraction(Count part, Count total)
{
    return total == 0
        ? 0.0
        : static_cast<double>(part) / static_cast<double>(total);
}

std::size_t HistogramBin(double value)
{
    return static_cast<std::size_t>(
        Clamp(std::floor(value + 0.5), 0.0, 255.0)
    );
}

int PercentileFromHistogram(
    const Histogram& histogram,
    Count total,
    double percentile
)
{
    if (total == 0) {
        return 0;
    }

    percentile = Clamp(percentile, 0.0, 1.0);

    Count cutoff = static_cast<Count>(
        std::ceil(static_cast<double>(total) * percentile)
    );
    cutoff = std::max<Count>(1, std::min(cutoff, total));

    Count accumulated = 0;

    for (std::size_t i = 0; i < histogram.size(); ++i) {
        accumulated += histogram[i];

        if (accumulated >= cutoff) {
            return static_cast<int>(i);
        }
    }

    return 255;
}

Count HistogramRangeCount(
    const Histogram& histogram,
    std::size_t first,
    std::size_t last_exclusive
)
{
    Count count = 0;

    for (std::size_t i = first; i < last_exclusive; ++i) {
        count += histogram[i];
    }

    return count;
}

template <typename T>
bool ValidateLayout(
    const T* pixel_buffer,
    int width,
    int height,
    int row_bytes
)
{
    if (!pixel_buffer || width <= 0 || height <= 0 || row_bytes == 0) {
        return false;
    }

    const std::uint64_t bytes_per_pixel =
        4u * static_cast<std::uint64_t>(sizeof(T));

    const std::uint64_t row_size =
        static_cast<std::uint64_t>(width) * bytes_per_pixel;

    // Convert before negation so INT_MIN is handled safely.
    const std::int64_t signed_stride = static_cast<std::int64_t>(row_bytes);

    const std::uint64_t stride = signed_stride < 0
        ? static_cast<std::uint64_t>(-signed_stride)
        : static_cast<std::uint64_t>(signed_stride);

    if (stride < row_size) {
        return false;
    }

    const std::uint64_t maximum_offset =
        static_cast<std::uint64_t>(
            std::numeric_limits<std::ptrdiff_t>::max()
        );

    if (row_size > maximum_offset) {
        return false;
    }

    const std::uint64_t remaining_rows =
        static_cast<std::uint64_t>(height - 1);

    if (
        remaining_rows != 0 &&
        stride > (maximum_offset - row_size) / remaining_rows
    ) {
        return false;
    }

    return true;
}

template <typename T>
struct ChannelTraits;

template <>
struct ChannelTraits<unsigned char> {
    static double Normalize(unsigned char value)
    {
        return static_cast<double>(value) / 255.0;
    }
};

template <>
struct ChannelTraits<unsigned short> {
    static double Normalize(unsigned short value)
    {
        return static_cast<double>(value) / 65535.0;
    }
};

template <>
struct ChannelTraits<float> {
    static double Normalize(float value)
    {
        return static_cast<double>(value);
    }
};

template <typename T>
class PixelReader {
public:
    PixelReader(const T* pixels, int row_bytes)
        : pixels_(reinterpret_cast<const unsigned char*>(pixels)),
          stride_(static_cast<std::ptrdiff_t>(row_bytes))
    {
    }

    const unsigned char* Row(int y) const
    {
        return pixels_ + static_cast<std::ptrdiff_t>(y) * stride_;
    }

    bool Read(
        const unsigned char* row,
        int x,
        Pixel& pixel
    ) const
    {
        /*
         * memcpy avoids alignment assumptions when row padding is not
         * naturally aligned for unsigned short or float.
         */
        T channels[4];

        const std::size_t offset =
            static_cast<std::size_t>(x) * 4u * sizeof(T);

        std::memcpy(channels, row + offset, sizeof(channels));

        pixel.r = ChannelTraits<T>::Normalize(channels[0]);
        pixel.g = ChannelTraits<T>::Normalize(channels[1]);
        pixel.b = ChannelTraits<T>::Normalize(channels[2]);
        pixel.a = ChannelTraits<T>::Normalize(channels[3]);

        if (
            !std::isfinite(pixel.r) ||
            !std::isfinite(pixel.g) ||
            !std::isfinite(pixel.b) ||
            !std::isfinite(pixel.a)
        ) {
            return false;
        }

        pixel.a = Clamp(pixel.a, 0.0, 1.0);

        if (pixel.a <= kAlphaThreshold) {
            return false;
        }

        pixel.r = std::max(0.0, pixel.r);
        pixel.g = std::max(0.0, pixel.g);
        pixel.b = std::max(0.0, pixel.b);

        return true;
    }

private:
    const unsigned char* pixels_;
    std::ptrdiff_t stride_;
};

double PeakChannel(const Pixel& pixel)
{
    return std::max(pixel.r, std::max(pixel.g, pixel.b));
}

template <typename Reader>
AnalysisBounds DetectContentBounds(
    const Reader& reader,
    int width,
    int height
)
{
    const AnalysisBounds full{0, 0, width, height};

    if (width < 8 || height < 8) {
        return full;
    }

    std::vector<Count> dark_rows(static_cast<std::size_t>(height), 0);
    std::vector<Count> dark_columns(static_cast<std::size_t>(width), 0);

    for (int y = 0; y < height; ++y) {
        const unsigned char* row = reader.Row(y);

        for (int x = 0; x < width; ++x) {
            Pixel pixel;

            if (!reader.Read(row, x, pixel) || PeakChannel(pixel) <= kDarkThreshold) {
                ++dark_rows[static_cast<std::size_t>(y)];
                ++dark_columns[static_cast<std::size_t>(x)];
            }
        }
    }

    const auto row_is_bar = [&](int y) {
        return static_cast<double>(
            dark_rows[static_cast<std::size_t>(y)]
        ) >= static_cast<double>(width) * kBarFraction;
    };

    const auto column_is_bar = [&](int x) {
        return static_cast<double>(
            dark_columns[static_cast<std::size_t>(x)]
        ) >= static_cast<double>(height) * kBarFraction;
    };

    const int minimum_rows = std::max(
        2,
        static_cast<int>(std::ceil(height * kMinimumContentFraction))
    );

    const int minimum_columns = std::max(
        2,
        static_cast<int>(std::ceil(width * kMinimumContentFraction))
    );

    int content_rows = 0;
    int content_columns = 0;

    for (int y = 0; y < height; ++y) {
        if (!row_is_bar(y)) {
            ++content_rows;
        }
    }

    for (int x = 0; x < width; ++x) {
        if (!column_is_bar(x)) {
            ++content_columns;
        }
    }

    // Avoid interpreting a predominantly dark frame as letterboxing.
    if (content_rows < minimum_rows || content_columns < minimum_columns) {
        return full;
    }

    AnalysisBounds candidate = full;

    while (candidate.top < candidate.bottom && row_is_bar(candidate.top)) {
        ++candidate.top;
    }

    while (
        candidate.bottom > candidate.top &&
        row_is_bar(candidate.bottom - 1)
    ) {
        --candidate.bottom;
    }

    while (
        candidate.left < candidate.right &&
        column_is_bar(candidate.left)
    ) {
        ++candidate.left;
    }

    while (
        candidate.right > candidate.left &&
        column_is_bar(candidate.right - 1)
    ) {
        --candidate.right;
    }

    const int candidate_width = candidate.right - candidate.left;
    const int candidate_height = candidate.bottom - candidate.top;

    const double full_area =
        static_cast<double>(width) * static_cast<double>(height);

    const double candidate_area =
        static_cast<double>(candidate_width) *
        static_cast<double>(candidate_height);

    /*
     * Accept the whole detected crop or none of it. Do not stop trimming
     * halfway through a bar just because a minimum-area limit was reached.
     *
     * This remains an image-content heuristic; naturally dark edges can
     * resemble bars.
     */
    if (
        candidate_width < minimum_columns ||
        candidate_height < minimum_rows ||
        candidate_area < full_area * kMinimumContentFraction
    ) {
        return full;
    }

    return candidate;
}

FloatMapping DetermineFloatMapping(
    const PixelReader<float>& reader,
    const AnalysisBounds& bounds
)
{
    std::array<Count, kHeadroomBins> histogram{};
    Count valid_count = 0;
    Count super_white_count = 0;

    for (int y = bounds.top; y < bounds.bottom; ++y) {
        const unsigned char* row = reader.Row(y);

        for (int x = bounds.left; x < bounds.right; ++x) {
            Pixel pixel;

            if (!reader.Read(row, x, pixel)) {
                continue;
            }

            ++valid_count;

            const double peak = PeakChannel(pixel);

            if (peak > kSuperWhiteThreshold) {
                ++super_white_count;
            }

            const double bounded_peak = Clamp(
                peak,
                0.0,
                kMaximumAnalysisHeadroom
            );

            const std::size_t bin = std::min(
                kHeadroomBins - 1,
                static_cast<std::size_t>(
                    bounded_peak / kMaximumAnalysisHeadroom *
                    static_cast<double>(kHeadroomBins)
                )
            );

            ++histogram[bin];
        }
    }

    FloatMapping mapping;

    if (valid_count == 0) {
        return mapping;
    }

    mapping.super_white_fraction = Fraction(super_white_count, valid_count);

    /*
     * Use an exact super-white count to decide whether compression is needed.
     * A quantized percentile near 1.0 must not classify an SDR frame as HDR.
     */
    if (
        mapping.super_white_fraction <= kSignificantSuperWhiteFraction
    ) {
        return mapping;
    }

    const Count target = std::max<Count>(
        1,
        static_cast<Count>(
            std::ceil(static_cast<double>(valid_count) * 0.99)
        )
    );

    Count cumulative = 0;
    std::size_t percentile_bin = kHeadroomBins - 1;

    for (std::size_t i = 0; i < histogram.size(); ++i) {
        cumulative += histogram[i];

        if (cumulative >= target) {
            percentile_bin = i;
            break;
        }
    }

    // Use the bin's upper edge to avoid underestimating the proxy white.
    const double robust_peak =
        static_cast<double>(percentile_bin + 1) /
        static_cast<double>(kHeadroomBins) *
        kMaximumAnalysisHeadroom;

    mapping.compress_headroom = true;
    mapping.analysis_white = Clamp(
        std::max(kSuperWhiteThreshold, robust_peak),
        kSuperWhiteThreshold,
        kMaximumAnalysisHeadroom
    );

    return mapping;
}

template <typename T>
FloatMapping DetermineMapping(
    const PixelReader<T>&,
    const AnalysisBounds&
)
{
    return FloatMapping{};
}

FloatMapping DetermineMapping(
    const PixelReader<float>& reader,
    const AnalysisBounds& bounds
)
{
    return DetermineFloatMapping(reader, bounds);
}

void MapPixelForAnalysis(Pixel& pixel, const FloatMapping& mapping)
{
    if (mapping.compress_headroom) {
        const double peak = PeakChannel(pixel);

        if (peak > 0.0) {
            const double mapped_peak = peak <= 1.0
                ? peak * 0.9
                : 0.9 + 0.1 * Clamp(
                    (peak - 1.0) / (mapping.analysis_white - 1.0),
                    0.0,
                    1.0
                );

            /*
             * Apply one multiplier to all channels. Independent channel
             * compression would distort RGB ratios used for white balance.
             */
            const double multiplier = mapped_peak / peak;

            pixel.r *= multiplier;
            pixel.g *= multiplier;
            pixel.b *= multiplier;
        }
    }

    pixel.r = Clamp(pixel.r, 0.0, 1.0);
    pixel.g = Clamp(pixel.g, 0.0, 1.0);
    pixel.b = Clamp(pixel.b, 0.0, 1.0);
}

double HueDegrees(const Pixel& pixel, double maximum, double delta)
{
    if (delta <= 0.0) {
        return 0.0;
    }

    double hue;

    if (maximum == pixel.r) {
        hue = 60.0 * ((pixel.g - pixel.b) / delta);
    } else if (maximum == pixel.g) {
        hue = 60.0 * (((pixel.b - pixel.r) / delta) + 2.0);
    } else {
        hue = 60.0 * (((pixel.r - pixel.g) / delta) + 4.0);
    }

    if (hue < 0.0) {
        hue += 360.0;
    }

    return hue;
}

template <typename Reader>
FrameStatistics CollectStatistics(
    const Reader& reader,
    const AnalysisBounds& bounds,
    const FloatMapping& mapping
)
{
    FrameStatistics stats;

    for (int y = bounds.top; y < bounds.bottom; ++y) {
        const unsigned char* row = reader.Row(y);

        for (int x = bounds.left; x < bounds.right; ++x) {
            Pixel pixel;

            if (!reader.Read(row, x, pixel)) {
                ++stats.rejected_count;
                continue;
            }

            MapPixelForAnalysis(pixel, mapping);

            const double r = pixel.r * 255.0;
            const double g = pixel.g * 255.0;
            const double b = pixel.b * 255.0;
            const double luma = Rec709Luma(r, g, b);

            ++stats.count;
            stats.r_sum += r;
            stats.g_sum += g;
            stats.b_sum += b;
            stats.luma_sum += luma;
            stats.luma_squared_sum += luma * luma;

            ++stats.luma_histogram[HistogramBin(luma)];
            ++stats.r_histogram[HistogramBin(r)];
            ++stats.g_histogram[HistogramBin(g)];
            ++stats.b_histogram[HistogramBin(b)];

            const double maximum = PeakChannel(pixel);
            const double minimum = std::min(
                pixel.r,
                std::min(pixel.g, pixel.b)
            );
            const double delta = maximum - minimum;
            const double saturation = maximum > 0.0 ? delta / maximum : 0.0;

            stats.saturation_sum += saturation;

            if (luma > 40.0 && luma < 215.0) {
                stats.mid_r_sum += r;
                stats.mid_g_sum += g;
                stats.mid_b_sum += b;
                ++stats.mid_count;
            }

            if (
                luma > 72.0 &&
                luma < 238.0 &&
                saturation <= 0.14 &&
                maximum >= 0.26
            ) {
                stats.neutral_r_sum += r;
                stats.neutral_g_sum += g;
                stats.neutral_b_sum += b;
                ++stats.neutral_count;
            }

            /*
             * Warm-color candidate heuristic, not face or skin recognition.
             * Its influence is restricted later to avoid treating wood,
             * clothing, or warm lighting as a reliable skin reference.
             */
            if (
                saturation >= 0.18 &&
                saturation <= 0.60 &&
                maximum >= 0.25 &&
                maximum <= 0.95
            ) {
                const double hue = HueDegrees(pixel, maximum, delta);

                if (hue >= 5.0 && hue <= 34.0) {
                    stats.skin_r_sum += r;
                    stats.skin_g_sum += g;
                    ++stats.skin_count;
                }
            }
        }
    }

    return stats;
}

void InitializeNeutralResult(FrameAnalysisResult& result)
{
    result.exposure = 0.0f;
    result.contrast = 0.0f;
    result.blacks = 0.0f;
    result.whites = 0.0f;
    result.highlights = 0.0f;
    result.shadows = 0.0f;
    result.temperature = 0.0f;
    result.tint = 0.0f;
    result.saturation = 100.0f;
    result.vibrance = 0.0f;
    result.shadows_temp = 0.0f;
    result.shadows_tint = 0.0f;
    result.highlights_temp = 0.0f;
    result.highlights_tint = 0.0f;
    result.confidence = 0.0f;
    result.is_low_light = false;
    result.is_log = false;
}

void AttenuateCorrections(FrameAnalysisResult& result, double strength)
{
    const float amount = ToFloat(Clamp(strength, 0.0, 1.0));

    result.exposure *= amount;
    result.contrast *= amount;
    result.blacks *= amount;
    result.whites *= amount;
    result.highlights *= amount;
    result.shadows *= amount;
    result.temperature *= amount;
    result.tint *= amount;
    result.saturation = 100.0f + (result.saturation - 100.0f) * amount;
    result.vibrance *= amount;
    result.shadows_temp *= amount;
    result.shadows_tint *= amount;
    result.highlights_temp *= amount;
    result.highlights_tint *= amount;
}

void CalculateRecommendations(
    const FrameStatistics& stats,
    const FloatMapping& mapping,
    FrameAnalysisResult& result
)
{
    InitializeNeutralResult(result);

    const double total = static_cast<double>(stats.count);
    const double mean_luma = stats.luma_sum / total;
    const double mean_saturation = stats.saturation_sum / total;

    const double variance = std::max(
        0.0,
        stats.luma_squared_sum / total - mean_luma * mean_luma
    );
    const double standard_deviation = std::sqrt(variance);

    const int shadow_luma = PercentileFromHistogram(
        stats.luma_histogram, stats.count, 0.01
    );
    const int luma_p10 = PercentileFromHistogram(
        stats.luma_histogram, stats.count, 0.10
    );
    const int luma_median = PercentileFromHistogram(
        stats.luma_histogram, stats.count, 0.50
    );
    const int luma_p90 = PercentileFromHistogram(
        stats.luma_histogram, stats.count, 0.90
    );
    const int highlight_luma = PercentileFromHistogram(
        stats.luma_histogram, stats.count, 0.99
    );

    const int r_median = PercentileFromHistogram(
        stats.r_histogram, stats.count, 0.50
    );
    const int g_median = PercentileFromHistogram(
        stats.g_histogram, stats.count, 0.50
    );
    const int b_median = PercentileFromHistogram(
        stats.b_histogram, stats.count, 0.50
    );

    const int waveform_spread = luma_p90 - luma_p10;

    const double shadow_crush_fraction = Fraction(
        HistogramRangeCount(stats.luma_histogram, 0, 15),
        stats.count
    );

    const double highlight_clip_fraction = Fraction(
        HistogramRangeCount(stats.luma_histogram, 248, 256),
        stats.count
    );

    result.is_low_light = luma_median < 58 && luma_p90 < 205;

    /*
     * Retained for API compatibility. This flag means "Log-like tonal
     * distribution", not an identified camera Log transfer function.
     * It must not be used to choose an input LUT or color-space transform.
     */
    result.is_log =
        !mapping.compress_headroom &&
        !result.is_low_light &&
        standard_deviation < 32.0 &&
        waveform_spread >= 45 &&
        shadow_luma > 25 &&
        highlight_luma < 235 &&
        luma_median > 45 &&
        luma_median < 210;

    /*
     * Blank, nearly uniform, or tiny frames provide insufficient evidence
     * for a reliable automatic grade. Return neutral controls instead of
     * strongly brightening black frames or recoloring flat graphics.
     */
    if (stats.count < 16 || standard_deviation < 1.5) {
        result.confidence = 0.0f;
        return;
    }

    // Scene-adaptive exposure suggestion.
    const double target_median = result.is_low_light
        ? 88.0
        : (result.is_log ? 116.0 : 106.0);

    const double median_difference = target_median - luma_median;
    const double exposure_scale = median_difference < 0.0 ? 0.95 : 1.65;

    double exposure =
        median_difference / 255.0 * exposure_scale;

    const double maximum_safe_exposure =
        (255.0 - highlight_luma) / 45.0;

    double exposure_ceiling = result.is_low_light
        ? 0.95
        : Clamp(maximum_safe_exposure, 0.05, 1.4);

    if (highlight_luma > 242 || luma_p90 > 215) {
        exposure_ceiling = std::min(exposure_ceiling, 0.28);
    }

    if (highlight_luma > 250) {
        exposure_ceiling = std::min(exposure_ceiling, 0.05);
    }

    exposure = Clamp(exposure, -0.90, exposure_ceiling);
    result.exposure = ToFloat(exposure);

    // Conservative tonal-range adjustment.
    if (result.is_log) {
        result.contrast = 24.0f;
        result.blacks = -6.0f;
        result.whites = 8.0f;
    } else if (waveform_spread > 155 || standard_deviation > 72.0) {
        result.contrast = 2.0f;
    } else {
        result.contrast = ToFloat(
            Clamp((145.0 - waveform_spread) * 0.18, 0.0, 22.0)
        );

        result.blacks = ToFloat(
            Clamp(
                shadow_luma > 18 ? -(shadow_luma - 18.0) * 0.25 : 0.0,
                -8.0,
                2.0
            )
        );

        result.whites = ToFloat(
            Clamp(
                highlight_luma < 228
                    ? (228.0 - highlight_luma) * 0.20
                    : 0.0,
                -6.0,
                10.0
            )
        );
    }

    /*
     * These controls redistribute available detail. They cannot reconstruct
     * information that was clipped before this frame reached the plugin.
     */
    if (highlight_clip_fraction > 0.02 || highlight_luma >= 248) {
        const double adjustment =
            -14.0 * std::sqrt(highlight_clip_fraction * 10.0) -
            (highlight_luma >= 248
                ? (highlight_luma - 248.0) * 1.5
                : 0.0);

        result.highlights = ToFloat(Clamp(adjustment, -28.0, 0.0));
    }

    if (shadow_crush_fraction > 0.02 || shadow_luma <= 6) {
        const double adjustment =
            18.0 * std::sqrt(shadow_crush_fraction * 10.0) +
            (shadow_luma <= 6
                ? (6.0 - shadow_luma) * 1.2
                : 0.0);

        result.shadows = ToFloat(Clamp(adjustment, 0.0, 26.0));
    }

    const double neutral_fraction = Fraction(stats.neutral_count, stats.count);
    const double mid_fraction = Fraction(stats.mid_count, stats.count);
    const double skin_fraction = Fraction(stats.skin_count, stats.count);

    const Count minimum_neutral_count = std::max<Count>(
        32,
        stats.count / 450
    );

    const bool has_neutral_reference =
        stats.neutral_count >= minimum_neutral_count;

    const double parade_rb_difference =
        static_cast<double>(r_median) - b_median;

    const double parade_g_difference =
        static_cast<double>(g_median) -
        (static_cast<double>(r_median) + b_median) * 0.5;

    const bool use_midtone_balance =
        !has_neutral_reference &&
        stats.mid_count >= 32 &&
        mid_fraction > 0.30 &&
        mean_saturation < 0.35 &&
        std::fabs(parade_rb_difference) < 45.0 &&
        std::fabs(parade_g_difference) < 30.0;

    if (has_neutral_reference || use_midtone_balance) {
        const Count balance_count = has_neutral_reference
            ? stats.neutral_count
            : stats.mid_count;

        const double denominator = static_cast<double>(balance_count);

        const double average_r = (
            has_neutral_reference ? stats.neutral_r_sum : stats.mid_r_sum
        ) / denominator;

        const double average_g = (
            has_neutral_reference ? stats.neutral_g_sum : stats.mid_g_sum
        ) / denominator;

        const double average_b = (
            has_neutral_reference ? stats.neutral_b_sum : stats.mid_b_sum
        ) / denominator;

        /*
         * RGB medians are not paired pixels and can reflect scene content.
         * Neutral samples receive most of the weight when available.
         * Midtone fallback remains weak and bounded.
         */
        const double reference_weight = has_neutral_reference
            ? Clamp((neutral_fraction - 0.002) / 0.040, 0.60, 0.95)
            : 0.35;

        double rb_difference =
            (average_r - average_b) * reference_weight +
            parade_rb_difference * (1.0 - reference_weight);

        double g_difference =
            (average_g - (average_r + average_b) * 0.5) * reference_weight +
            parade_g_difference * (1.0 - reference_weight);

        rb_difference = ApplyDeadZone(rb_difference, 1.8);
        g_difference = ApplyDeadZone(g_difference, 1.2);

        const double temperature_scale =
            has_neutral_reference ? 0.52 : 0.22;

        const double tint_scale =
            has_neutral_reference ? 0.48 : 0.20;

        result.temperature = ToFloat(
            Clamp(
                -rb_difference * temperature_scale,
                has_neutral_reference ? -22.0 : -8.0,
                has_neutral_reference ? 24.0 : 8.0
            )
        );

        result.tint = ToFloat(
            Clamp(
                g_difference * tint_scale,
                has_neutral_reference ? -16.0 : -6.0,
                has_neutral_reference ? 16.0 : 6.0
            )
        );
    }

    // Weak warm-color protection, never a standalone white-balance reference.
    if (
        has_neutral_reference &&
        stats.skin_count >= 64 &&
        skin_fraction >= 0.005 &&
        skin_fraction <= 0.35
    ) {
        const double average_skin_r =
            stats.skin_r_sum / static_cast<double>(stats.skin_count);

        const double average_skin_g =
            stats.skin_g_sum / static_cast<double>(stats.skin_count);

        if (average_skin_g > 0.0) {
            const double rg_ratio = average_skin_r / average_skin_g;
            double temperature_adjustment = 0.0;
            double tint_adjustment = 0.0;

            if (rg_ratio > 1.48) {
                temperature_adjustment = -(rg_ratio - 1.48) * 6.0;
            } else if (rg_ratio < 1.18) {
                temperature_adjustment = (1.18 - rg_ratio) * 8.0;
                tint_adjustment = (1.18 - rg_ratio) * 4.0;
            }

            result.temperature += ToFloat(
                Clamp(temperature_adjustment, -2.0, 2.0)
            );
            result.tint += ToFloat(
                Clamp(tint_adjustment, -1.0, 1.0)
            );
        }
    }

    result.temperature = Clamp(result.temperature, -24.0f, 24.0f);
    result.tint = Clamp(result.tint, -16.0f, 16.0f);

    /*
     * Reduce added saturation in already colorful footage and avoid
     * amplifying tiny channel differences in near-monochrome footage.
     */
    const double color_presence =
        Clamp((mean_saturation - 0.01) / 0.07, 0.0, 1.0);

    const double saturation_headroom =
        Clamp((0.65 - mean_saturation) / 0.40, 0.0, 1.0);

    const double color_strength =
        color_presence * saturation_headroom;

    const double saturation_boost = result.is_log
        ? 20.0
        : (result.is_low_light ? 6.0 : 12.0);

    const double vibrance_boost = result.is_log
        ? 18.0
        : (result.is_low_light ? 10.0 : 14.0);

    result.saturation = ToFloat(
        100.0 + saturation_boost * color_strength
    );

    result.vibrance = ToFloat(vibrance_boost * color_strength);

    /*
     * Confidence is a heuristic evidence score, not a calibrated
     * probability that the proposed grade is correct.
     */
    double confidence = 1.0;

    if (result.is_low_light) confidence -= 0.12;
    if (highlight_clip_fraction > 0.15) confidence -= 0.18;
    if (shadow_crush_fraction > 0.15) confidence -= 0.12;
    if (waveform_spread < 38) confidence -= 0.08;
    if (standard_deviation < 12.0) confidence -= 0.06;

    if (!has_neutral_reference && !use_midtone_balance) {
        confidence -= 0.10;
    }

    const double sample_evidence = Clamp(
        std::sqrt(total / 256.0),
        0.0,
        1.0
    );

    const double tonal_evidence = Clamp(
        (standard_deviation - 1.5) / 10.5,
        0.0,
        1.0
    );

    const double valid_fraction = Fraction(
        stats.count,
        stats.count + stats.rejected_count
    );

    const double correction_strength =
        sample_evidence * tonal_evidence;

    AttenuateCorrections(result, correction_strength);

    confidence *= correction_strength;
    confidence *= 0.5 + 0.5 * valid_fraction;

    if (mapping.compress_headroom) {
        /*
         * The proxy's highlights no longer correspond to SDR clipping.
         * Do not derive a strong tonal grade from that artificial shoulder.
         * Proper HDR/linear grading requires caller-provided color metadata.
         */
        result.is_log = false;
        result.exposure = 0.0f;
        result.contrast = 0.0f;
        result.blacks = 0.0f;
        result.whites = 0.0f;
        result.highlights = 0.0f;
        result.shadows = 0.0f;
        result.saturation = 100.0f;
        result.vibrance = 0.0f;

        result.temperature *= 0.35f;
        result.tint *= 0.35f;

        confidence = std::min(confidence, 0.40);
    }

    result.confidence = ToFloat(Clamp(confidence, 0.0, 1.0));
}

template <typename T>
bool AnalyzeFrame(
    const T* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
)
{
    if (!ValidateLayout(pixel_buffer, width, height, row_bytes)) {
        return false;
    }

    const PixelReader<T> reader(pixel_buffer, row_bytes);

    const AnalysisBounds bounds =
        DetectContentBounds(reader, width, height);

    const FloatMapping mapping =
        DetermineMapping(reader, bounds);

    const FrameStatistics stats =
        CollectStatistics(reader, bounds, mapping);

    if (stats.count == 0) {
        // Fully transparent or invalid frames have no usable color evidence.
        return false;
    }

    FrameAnalysisResult candidate{};
    CalculateRecommendations(stats, mapping, candidate);

    // Commit only after the entire analysis completes successfully.
    result = candidate;
    return true;
}

template <typename T>
bool AnalyzeFrameSafely(
    const T* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
)
{
    try {
        return AnalyzeFrame(
            pixel_buffer,
            width,
            height,
            row_bytes,
            result
        );
    } catch (const std::bad_alloc&) {
        return false;
    } catch (const std::length_error&) {
        return false;
    }
}

} // namespace

bool ColorEngine::AnalyzeFrame8(
    const unsigned char* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
)
{
    static_assert(
        std::numeric_limits<unsigned char>::digits == 8,
        "AnalyzeFrame8 requires 8-bit unsigned char."
    );

    return AnalyzeFrameSafely(
        pixel_buffer,
        width,
        height,
        row_bytes,
        result
    );
}

bool ColorEngine::AnalyzeFrame16(
    const unsigned short* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
)
{
    static_assert(
        std::numeric_limits<unsigned short>::digits == 16,
        "AnalyzeFrame16 requires 16-bit unsigned short."
    );

    return AnalyzeFrameSafely(
        pixel_buffer,
        width,
        height,
        row_bytes,
        result
    );
}

bool ColorEngine::AnalyzeFrame32(
    const float* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
)
{
    static_assert(
        sizeof(float) == 4 && std::numeric_limits<float>::is_iec559,
        "AnalyzeFrame32 requires IEEE-754 32-bit float."
    );

    return AnalyzeFrameSafely(
        pixel_buffer,
        width,
        height,
        row_bytes,
        result
    );
}