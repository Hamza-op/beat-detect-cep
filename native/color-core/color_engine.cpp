#include "color_engine.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

static int PercentileFromHistogram(const int histogram[256], int total_pixels, float percentile)
{
    int cutoff = static_cast<int>(total_pixels * percentile);
    cutoff = std::max(1, cutoff);
    int accumulated = 0;
    for (int i = 0; i < 256; ++i) {
        accumulated += histogram[i];
        if (accumulated >= cutoff) {
            return i;
        }
    }
    return 255;
}

static float ClampFloat(float value, float min_value, float max_value)
{
    return std::max(min_value, std::min(max_value, value));
}

static float Rec709Luma(float r, float g, float b)
{
    return 0.2126f * r + 0.7152f * g + 0.0722f * b;
}

static unsigned char Standard16To8(unsigned short value)
{
    return static_cast<unsigned char>((static_cast<unsigned int>(value) * 255u + 32767u) / 65535u);
}

static float ApplyDeadZone(float value, float dead_zone)
{
    if (std::fabs(value) <= dead_zone) {
        return 0.0f;
    }
    return value > 0.0f ? value - dead_zone : value + dead_zone;
}

template <typename T, bool Is16Bit>
static inline unsigned char GetChannel8(T val) {
    if (Is16Bit) {
        return Standard16To8(static_cast<unsigned short>(val));
    } else {
        return static_cast<unsigned char>(val);
    }
}

struct AnalysisBounds {
    int left;
    int top;
    int right;
    int bottom;
};

template <typename T, bool Is16Bit>
static AnalysisBounds DetectContentBounds(
    const T* pixel_buffer,
    int width,
    int height,
    int row_bytes
) {
    AnalysisBounds full{0, 0, width, height};
    if (width < 8 || height < 8) {
        return full;
    }

    std::vector<int> dark_rows(static_cast<size_t>(height), 0);
    std::vector<int> dark_columns(static_cast<size_t>(width), 0);
    for (int y = 0; y < height; ++y) {
        const T* row = reinterpret_cast<const T*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + (y * row_bytes)
        );
        for (int x = 0; x < width; ++x) {
            const unsigned char r = GetChannel8<T, Is16Bit>(row[x * 4 + 0]);
            const unsigned char g = GetChannel8<T, Is16Bit>(row[x * 4 + 1]);
            const unsigned char b = GetChannel8<T, Is16Bit>(row[x * 4 + 2]);
            const unsigned char a = GetChannel8<T, Is16Bit>(row[x * 4 + 3]);
            const unsigned char max_channel = std::max({r, g, b});
            // Letterbox pixels are nearly black across all channels. Treat
            // transparent black as empty as well, but do not trim an entire
            // genuinely dark frame unless a real content region remains.
            if (a <= 3 || max_channel <= 10) {
                dark_rows[static_cast<size_t>(y)]++;
                dark_columns[static_cast<size_t>(x)]++;
            }
        }
    }

    const int minimum_content_rows = std::max(2, static_cast<int>(height * 0.20f));
    const int minimum_content_columns = std::max(2, static_cast<int>(width * 0.20f));
    const auto row_is_bar = [&](int y) {
        return static_cast<double>(dark_rows[static_cast<size_t>(y)]) >=
               static_cast<double>(width) * 0.97;
    };
    const auto column_is_bar = [&](int x) {
        return static_cast<double>(dark_columns[static_cast<size_t>(x)]) >=
               static_cast<double>(height) * 0.97;
    };

    int content_rows = 0;
    for (int y = 0; y < height; ++y) {
        if (!row_is_bar(y)) {
            content_rows++;
        }
    }
    int content_columns = 0;
    for (int x = 0; x < width; ++x) {
        if (!column_is_bar(x)) {
            content_columns++;
        }
    }
    if (content_rows < minimum_content_rows || content_columns < minimum_content_columns) {
        return full;
    }

    int left = 0;
    int top = 0;
    int right = width;
    int bottom = height;
    const double full_area = static_cast<double>(width) * static_cast<double>(height);
    const auto candidate_is_safe = [&](int candidate_left, int candidate_top,
                                        int candidate_right, int candidate_bottom) {
        const double candidate_area =
            static_cast<double>(candidate_right - candidate_left) *
            static_cast<double>(candidate_bottom - candidate_top);
        return candidate_right - candidate_left >= minimum_content_columns &&
               candidate_bottom - candidate_top >= minimum_content_rows &&
               candidate_area >= full_area * 0.20;
    };

    bool changed = true;
    while (changed) {
        changed = false;
        if (top < bottom && row_is_bar(top) && candidate_is_safe(left, top + 1, right, bottom)) {
            top++;
            changed = true;
        }
        if (bottom > top && row_is_bar(bottom - 1) &&
            candidate_is_safe(left, top, right, bottom - 1)) {
            bottom--;
            changed = true;
        }
        if (left < right && column_is_bar(left) &&
            candidate_is_safe(left + 1, top, right, bottom)) {
            left++;
            changed = true;
        }
        if (right > left && column_is_bar(right - 1) &&
            candidate_is_safe(left, top, right - 1, bottom)) {
            right--;
            changed = true;
        }
    }

    return AnalysisBounds{left, top, right, bottom};
}

template <typename T, bool Is16Bit>
static bool AnalyzeFrameTemplate(
    const T* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
) {
    if (!pixel_buffer || width <= 0 || height <= 0) {
        return false;
    }
    int bytes_per_pixel = Is16Bit ? 8 : 4;
    if (width > std::numeric_limits<int>::max() / height || row_bytes / bytes_per_pixel < width) {
        return false;
    }

    long long r_sum = 0, g_sum = 0, b_sum = 0;
    long long mid_r_sum = 0, mid_g_sum = 0, mid_b_sum = 0;
    int mid_count = 0;
    long long neutral_r_sum = 0, neutral_g_sum = 0, neutral_b_sum = 0;
    int neutral_count = 0;

    int histogram[256] = {0};
    int r_histogram[256] = {0};
    int g_histogram[256] = {0};
    int b_histogram[256] = {0};
    int skin_r_sum = 0, skin_g_sum = 0;
    int skin_count = 0;

    const AnalysisBounds bounds =
        DetectContentBounds<T, Is16Bit>(pixel_buffer, width, height, row_bytes);
    const int analysis_width = bounds.right - bounds.left;
    const int analysis_height = bounds.bottom - bounds.top;
    const int total_pixels = analysis_width * analysis_height;

    for (int y = bounds.top; y < bounds.bottom; ++y) {
        const T* row = reinterpret_cast<const T*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + (y * row_bytes)
        );
        for (int x = bounds.left; x < bounds.right; ++x) {
            // RGBA layout (4 bytes/shorts per pixel)
            unsigned char r = GetChannel8<T, Is16Bit>(row[x * 4 + 0]);
            unsigned char g = GetChannel8<T, Is16Bit>(row[x * 4 + 1]);
            unsigned char b = GetChannel8<T, Is16Bit>(row[x * 4 + 2]);
            
            r_sum += r;
            g_sum += g;
            b_sum += b;

            int luma = static_cast<int>(Rec709Luma(static_cast<float>(r), static_cast<float>(g), static_cast<float>(b)));
            luma = std::max(0, std::min(255, luma));
            histogram[luma]++;
            r_histogram[r]++;
            g_histogram[g]++;
            b_histogram[b]++;

            // Midtones for neutral gray balance (ignore extreme highlights/shadows)
            if (luma > 40 && luma < 215) {
                mid_r_sum += r;
                mid_g_sum += g;
                mid_b_sum += b;
                mid_count++;
            }

            // Robust HSV skin tone detector
            float rf = static_cast<float>(r) / 255.0f;
            float gf = static_cast<float>(g) / 255.0f;
            float bf = static_cast<float>(b) / 255.0f;

            float mx = std::max({rf, gf, bf});
            float mn = std::min({rf, gf, bf});
            float df = mx - mn;

            float h = 0.0f;
            if (df > 0.0f) {
                if (mx == rf) {
                    h = 60.0f * fmod(((gf - bf) / df), 6.0f);
                } else if (mx == gf) {
                    h = 60.0f * (((bf - rf) / df) + 2.0f);
                } else {
                    h = 60.0f * (((rf - gf) / df) + 4.0f);
                }
                if (h < 0.0f) {
                    h += 360.0f;
                }
            }
            float s = (mx > 0.0f) ? (df / mx) : 0.0f;
            float v = mx;

            // Skin bounds: Hue [5.0, 34.0], Saturation [0.18, 0.60], Value [0.25, 0.95]
            if (h >= 5.0f && h <= 34.0f && s >= 0.18f && s <= 0.60f && v >= 0.25f && v <= 0.95f) {
                skin_r_sum += r;
                skin_g_sum += g;
                skin_count++;
            }

            if (luma > 72 && luma < 238 && s <= 0.14f && v >= 0.26f) {
                neutral_r_sum += r;
                neutral_g_sum += g;
                neutral_b_sum += b;
                neutral_count++;
            }
        }
    }

    float mean_r = static_cast<float>(r_sum) / total_pixels;
    float mean_g = static_cast<float>(g_sum) / total_pixels;
    float mean_b = static_cast<float>(b_sum) / total_pixels;
    float mean_y = Rec709Luma(mean_r, mean_g, mean_b);

    // Waveform and RGB Parade percentiles.
    int shadow_luma = PercentileFromHistogram(histogram, total_pixels, 0.01f);
    int luma_p10 = PercentileFromHistogram(histogram, total_pixels, 0.10f);
    int luma_median = PercentileFromHistogram(histogram, total_pixels, 0.50f);
    int luma_p90 = PercentileFromHistogram(histogram, total_pixels, 0.90f);
    int highlight_luma = PercentileFromHistogram(histogram, total_pixels, 0.99f);
    int r_median = PercentileFromHistogram(r_histogram, total_pixels, 0.50f);
    int g_median = PercentileFromHistogram(g_histogram, total_pixels, 0.50f);
    int b_median = PercentileFromHistogram(b_histogram, total_pixels, 0.50f);

    // Standard deviation of luminance for contrast check
    float var_sum = 0;
    for (int i = 0; i < 256; ++i) {
        if (histogram[i] > 0) {
            float diff = i - mean_y;
            var_sum += histogram[i] * (diff * diff);
        }
    }
    float std_dev = std::sqrt(var_sum / static_cast<float>(total_pixels));

    // Identify footage traits. A flat-looking frame is not automatically Log:
    // a plain wall, fog, or a nearly uniform gray frame can have low variance
    // without needing a Log contrast lift.
    const int waveform_spread = luma_p90 - luma_p10;
    result.is_low_light = (luma_median < 58.0f && luma_p90 < 205.0f);
    result.is_log =
        !result.is_low_light &&
        std_dev < 32.0f &&
        waveform_spread >= 45 &&
        shadow_luma > 25 &&
        highlight_luma < 235 &&
        luma_median > 45 &&
        luma_median < 210;

    // Scene-Adaptive Exposure Calculation
    float target_median = result.is_low_light ? 88.0f : (result.is_log ? 116.0f : 106.0f);
    float median_diff = target_median - static_cast<float>(luma_median);
    float exposure_scale = median_diff < 0.0f ? 0.95f : 1.65f;
    result.exposure = (median_diff / 255.0f) * exposure_scale;
    float max_safe_exposure = (255.0f - static_cast<float>(highlight_luma)) / 45.0f;
    float exposure_ceiling = result.is_low_light ? 0.95f : std::max(0.05f, std::min(1.4f, max_safe_exposure));
    if (highlight_luma > 242 || luma_p90 > 215) {
        exposure_ceiling = std::min(exposure_ceiling, 0.28f);
    }
    if (highlight_luma > 250) {
        exposure_ceiling = std::min(exposure_ceiling, 0.05f);
    }
    result.exposure = ClampFloat(result.exposure, -0.90f, exposure_ceiling);

    // Film S-Curve Contrast & Dynamic Range Stretch
    if (result.is_log) {
        result.contrast = 24.0f;
        result.blacks = -6.0f;
        result.whites = 8.0f;
    } else {
        if (waveform_spread > 155 || std_dev > 72.0f) {
            result.contrast = 2.0f;
            result.blacks = 0.0f;
            result.whites = 0.0f;
        } else {
            float spread_deficit = 145.0f - static_cast<float>(waveform_spread);
            result.contrast = ClampFloat(spread_deficit * 0.18f, 0.0f, 22.0f);
            result.blacks = (shadow_luma > 18) ? -((shadow_luma - 18) * 0.25f) : 0.0f;
            result.blacks = ClampFloat(result.blacks, -8.0f, 2.0f);
            result.whites = (highlight_luma < 228) ? ((228 - highlight_luma) * 0.20f) : 0.0f;
            result.whites = ClampFloat(result.whites, -6.0f, 10.0f);
        }
    }

    // Highlights Recovery & Shadow Detail Lift
    int shadow_crushed_pixels = 0;
    for (int i = 0; i < 15; ++i) shadow_crushed_pixels += histogram[i];
    int highlight_clipped_pixels = 0;
    for (int i = 248; i < 256; ++i) highlight_clipped_pixels += histogram[i];

    float shadow_crush_pct = static_cast<float>(shadow_crushed_pixels) / total_pixels;
    float highlight_clip_pct = static_cast<float>(highlight_clipped_pixels) / total_pixels;

    if (highlight_clip_pct > 0.02f || highlight_luma >= 248) {
        result.highlights = -14.0f * std::sqrt(highlight_clip_pct * 10.0f) - (highlight_luma >= 248 ? (highlight_luma - 248) * 1.5f : 0.0f);
    } else {
        result.highlights = 0.0f;
    }
    result.highlights = ClampFloat(result.highlights, -28.0f, 4.0f);

    if (shadow_crush_pct > 0.02f || shadow_luma <= 6) {
        result.shadows = 18.0f * std::sqrt(shadow_crush_pct * 10.0f) + (shadow_luma <= 6 ? (6 - shadow_luma) * 1.2f : 0.0f);
    } else {
        result.shadows = 0.0f;
    }
    result.shadows = ClampFloat(result.shadows, -4.0f, 26.0f);

    // Multi-Zone Perceptual White Balance
    result.temperature = 0.0f;
    result.tint = 0.0f;

    const bool has_neutral_reference =
        neutral_count > std::max(200, total_pixels / 450);
    const float parade_rb_diff = static_cast<float>(r_median - b_median);
    const float parade_g_diff =
        static_cast<float>(g_median) - static_cast<float>(r_median + b_median) * 0.5f;

    const bool use_midtone_balance =
        !has_neutral_reference &&
        mid_count > static_cast<int>(total_pixels * 0.30f) &&
        std::fabs(parade_rb_diff) < 45.0f &&
        std::fabs(parade_g_diff) < 30.0f;

    int balance_count =
        has_neutral_reference ? neutral_count : (use_midtone_balance ? mid_count : 0);
    if (balance_count > 80) {
        float avg_balance_r = static_cast<float>(has_neutral_reference ? neutral_r_sum : mid_r_sum) / balance_count;
        float avg_balance_g = static_cast<float>(has_neutral_reference ? neutral_g_sum : mid_g_sum) / balance_count;
        float avg_balance_b = static_cast<float>(has_neutral_reference ? neutral_b_sum : mid_b_sum) / balance_count;

        float neutral_rb_diff = avg_balance_r - avg_balance_b;
        float neutral_fraction = static_cast<float>(neutral_count) / static_cast<float>(total_pixels);
        float neutral_weight = has_neutral_reference ? ClampFloat((neutral_fraction - 0.002f) / 0.040f, 0.40f, 0.88f) : 0.0f;
        float rb_diff = (neutral_rb_diff * neutral_weight) + (parade_rb_diff * (1.0f - neutral_weight));
        rb_diff = ApplyDeadZone(rb_diff, 1.8f);
        float rb_scale = has_neutral_reference ? 0.52f : 0.22f;
        float rb_limit_cool = has_neutral_reference ? -22.0f : -8.0f;
        float rb_limit_warm = has_neutral_reference ? 24.0f : 8.0f;

        if (rb_diff > 0.0f) {
            result.temperature = std::max(rb_limit_cool, -rb_diff * rb_scale);
        } else {
            result.temperature = std::min(rb_limit_warm, -rb_diff * rb_scale);
        }

        float avg_rb = (avg_balance_r + avg_balance_b) * 0.5f;
        float neutral_g_diff = avg_balance_g - avg_rb;
        float g_diff = (neutral_g_diff * neutral_weight) + (parade_g_diff * (1.0f - neutral_weight));
        g_diff = ApplyDeadZone(g_diff, 1.2f);
        float tint_scale = has_neutral_reference ? 0.48f : 0.20f;
        float tint_limit = has_neutral_reference ? 16.0f : 6.0f;
        result.tint = g_diff * tint_scale;
        result.tint = ClampFloat(result.tint, -tint_limit, tint_limit);
    }

    // Vectorscope Skin Tone Anchor & Protection
    if (skin_count > 180) {
        float avg_skin_r = static_cast<float>(skin_r_sum) / skin_count;
        float avg_skin_g = static_cast<float>(skin_g_sum) / skin_count;
        float rg_ratio = avg_skin_r / (avg_skin_g + 0.001f);
        if (rg_ratio > 1.48f) {
            result.temperature -= (rg_ratio - 1.48f) * 6.0f;
        } else if (rg_ratio < 1.18f) {
            result.temperature += (1.18f - rg_ratio) * 8.0f;
            result.tint += (1.18f - rg_ratio) * 4.0f;
        }
    }

    // Final safety boundaries
    result.temperature = ClampFloat(result.temperature, -24.0f, 24.0f);
    result.tint = ClampFloat(result.tint, -16.0f, 16.0f);

    // Intelligent Vibrance & Film Saturation
    if (result.is_log) {
        result.saturation = 120.0f;
        result.vibrance = 18.0f;
    } else if (result.is_low_light) {
        result.saturation = 106.0f;
        result.vibrance = 10.0f;
    } else {
        result.saturation = 112.0f;
        result.vibrance = 14.0f;
    }

    result.shadows_temp = 0.0f;
    result.shadows_tint = 0.0f;
    result.highlights_temp = 0.0f;
    result.highlights_tint = 0.0f;

    // Confidence Calculation
    float confidence = 1.0f;
    if (result.is_low_light) confidence -= 0.12f;
    if (highlight_clip_pct > 0.15f) confidence -= 0.18f;
    if (shadow_crush_pct > 0.15f) confidence -= 0.12f;
    if (waveform_spread < 38) confidence -= 0.08f;
    if (std_dev < 12.0f) confidence -= 0.06f;
    if (!has_neutral_reference && !use_midtone_balance && skin_count < total_pixels / 100) {
        confidence -= 0.08f;
    }
    result.confidence = ClampFloat(confidence, 0.30f, 1.0f);

    return true;
}

bool ColorEngine::AnalyzeFrame8(
    const unsigned char* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
) {
    return AnalyzeFrameTemplate<unsigned char, false>(pixel_buffer, width, height, row_bytes, result);
}

bool ColorEngine::AnalyzeFrame16(
    const unsigned short* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
) {
    return AnalyzeFrameTemplate<unsigned short, true>(pixel_buffer, width, height, row_bytes, result);
}

bool ColorEngine::AnalyzeFrame32(
    const float* pixel_buffer,
    int width,
    int height,
    int row_bytes,
    FrameAnalysisResult& result
) {
    if (!pixel_buffer || width <= 0 || height <= 0 || row_bytes < width * 4 * static_cast<int>(sizeof(float))) {
        return false;
    }
    // Premiere float frames can legitimately carry scene-referred values above
    // 1.0. Preserve their ordering instead of clipping every super-white to the
    // same 8-bit value. SDR frames remain byte-for-byte equivalent to the
    // existing path; HDR frames reserve the top 10% for highlight headroom.
    constexpr int kHeadroomBins = 512;
    constexpr float kMaxHeadroom = 16.0f;
    size_t headroom_histogram[kHeadroomBins] = {};
    size_t pixel_count = 0;
    for (int y = 0; y < height; ++y) {
        const float* source = reinterpret_cast<const float*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + static_cast<size_t>(y) * row_bytes);
        for (int x = 0; x < width; ++x) {
            const size_t offset = static_cast<size_t>(x) * 4u;
            const float r = std::isfinite(source[offset]) ? std::max(0.0f, source[offset]) : 0.0f;
            const float g = std::isfinite(source[offset + 1]) ? std::max(0.0f, source[offset + 1]) : 0.0f;
            const float b = std::isfinite(source[offset + 2]) ? std::max(0.0f, source[offset + 2]) : 0.0f;
            const float peak = std::min(kMaxHeadroom, std::max(r, std::max(g, b)));
            const int bin = std::min(
                kHeadroomBins - 1,
                static_cast<int>((peak / kMaxHeadroom) * static_cast<float>(kHeadroomBins - 1))
            );
            ++headroom_histogram[bin];
            ++pixel_count;
        }
    }

    const size_t percentile_target = std::max<size_t>(1, (pixel_count * 99u + 99u) / 100u);
    size_t cumulative = 0;
    int percentile_bin = 0;
    for (; percentile_bin < kHeadroomBins; ++percentile_bin) {
        cumulative += headroom_histogram[percentile_bin];
        if (cumulative >= percentile_target) {
            break;
        }
    }
    const float robust_peak =
        (static_cast<float>(percentile_bin) / static_cast<float>(kHeadroomBins - 1)) * kMaxHeadroom;
    const bool has_hdr_headroom = robust_peak > 1.02f;
    const float analysis_white = std::max(1.02f, robust_peak);

    std::vector<unsigned char> converted(static_cast<size_t>(width) * static_cast<size_t>(height) * 4u);
    for (int y = 0; y < height; ++y) {
        const float* source = reinterpret_cast<const float*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + static_cast<size_t>(y) * row_bytes);
        for (int x = 0; x < width; ++x) {
            const size_t source_offset = static_cast<size_t>(x) * 4u;
            const size_t destination_offset =
                static_cast<size_t>(y) * static_cast<size_t>(width) * 4u + source_offset;
            for (int channel = 0; channel < 3; ++channel) {
                const float raw = std::isfinite(source[source_offset + channel])
                    ? std::max(0.0f, source[source_offset + channel])
                    : 0.0f;
                float mapped = raw;
                if (has_hdr_headroom) {
                    mapped = raw <= 1.0f
                        ? raw * 0.9f
                        : 0.9f + 0.1f * ClampFloat((raw - 1.0f) / (analysis_white - 1.0f), 0.0f, 1.0f);
                }
                converted[destination_offset + static_cast<size_t>(channel)] =
                    static_cast<unsigned char>(ClampFloat(mapped, 0.0f, 1.0f) * 255.0f + 0.5f);
            }
            const float alpha = std::isfinite(source[source_offset + 3])
                ? source[source_offset + 3]
                : 0.0f;
            converted[destination_offset + 3] =
                static_cast<unsigned char>(ClampFloat(alpha, 0.0f, 1.0f) * 255.0f + 0.5f);
        }
    }
    return AnalyzeFrame8(converted.data(), width, height, width * 4, result);
}
