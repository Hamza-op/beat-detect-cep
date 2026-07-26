#include "color_engine.h"
#include <algorithm>
#include <cmath>
#include <limits>

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
    int skin_r_sum = 0, skin_g_sum = 0, skin_b_sum = 0;
    int skin_count = 0;

    int total_pixels = width * height;

    for (int y = 0; y < height; ++y) {
        const T* row = reinterpret_cast<const T*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + (y * row_bytes)
        );
        for (int x = 0; x < width; ++x) {
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
                skin_b_sum += b;
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

    // Identify footage traits
    result.is_low_light = (mean_y < 50.0f);
    result.is_log = (std_dev < 32.0f && shadow_luma > 25 && highlight_luma < 225);

    // Wedding-safe exposure
    float target_median = result.is_low_light ? 86.0f : 108.0f;
    float median_diff = target_median - static_cast<float>(luma_median);
    float exposure_scale = median_diff < 0.0f ? 0.65f : 1.45f;
    result.exposure = (median_diff / 255.0f) * exposure_scale;
    float exposure_ceiling = result.is_low_light ? 0.62f : 0.38f;
    if (highlight_luma > 242 || luma_p90 > 210) {
        exposure_ceiling = std::min(exposure_ceiling, 0.18f);
    }
    if (highlight_luma > 250) {
        exposure_ceiling = std::min(exposure_ceiling, 0.05f);
    }
    result.exposure = std::max(-0.20f, std::min(exposure_ceiling, result.exposure));

    // Calibrated Contrast
    if (result.is_log) {
        result.contrast = 18.0f;
    } else {
        int waveform_spread = luma_p90 - luma_p10;
        if (waveform_spread > 145 || std_dev > 68.0f) {
            result.contrast = 0.0f;
        } else {
            float dev_ratio = 135.0f - static_cast<float>(waveform_spread);
            result.contrast = dev_ratio * 0.08f;
            result.contrast = std::max(0.0f, std::min(12.0f, result.contrast));
        }
    }

    // Calibrated Highlights & Shadows
    int shadow_crushed_pixels = 0;
    for (int i = 0; i < 15; ++i) shadow_crushed_pixels += histogram[i];
    int highlight_clipped_pixels = 0;
    for (int i = 248; i < 256; ++i) highlight_clipped_pixels += histogram[i];

    float shadow_crush_pct = static_cast<float>(shadow_crushed_pixels) / total_pixels;
    float highlight_clip_pct = static_cast<float>(highlight_clipped_pixels) / total_pixels;

    if (highlight_clip_pct > 0.08f || highlight_luma >= 253) {
        result.highlights = -3.0f * std::sqrt(highlight_clip_pct);
        result.whites = 0.0f;
    } else {
        result.highlights = 0.0f;
        result.whites = highlight_luma < 220 ? 1.5f : 0.5f;
    }
    result.highlights = std::max(-4.0f, std::min(5.0f, result.highlights));
    result.whites = std::max(-5.0f, std::min(5.0f, result.whites));

    // Shadows & Blacks recovery
    if (shadow_crush_pct > 0.02f) {
        result.shadows = 12.0f * std::sqrt(shadow_crush_pct);
        result.blacks = 0.0f;
    } else {
        result.shadows = 0.0f;
        result.blacks = 0.0f;
    }
    result.shadows = std::max(-5.0f, std::min(18.0f, result.shadows));
    result.blacks = std::max(-5.0f, std::min(5.0f, result.blacks));

    // Calibrated color correction
    result.temperature = 0.0f;
    result.tint = 0.0f;

    bool has_neutral_reference = neutral_count > std::max(240, total_pixels / 420);
    int balance_count = has_neutral_reference ? neutral_count : mid_count;
    if (balance_count > 100) {
        float avg_balance_r = static_cast<float>(has_neutral_reference ? neutral_r_sum : mid_r_sum) / balance_count;
        float avg_balance_g = static_cast<float>(has_neutral_reference ? neutral_g_sum : mid_g_sum) / balance_count;
        float avg_balance_b = static_cast<float>(has_neutral_reference ? neutral_b_sum : mid_b_sum) / balance_count;

        float parade_rb_diff = static_cast<float>(r_median - b_median);
        float neutral_rb_diff = avg_balance_r - avg_balance_b;
        float neutral_fraction = static_cast<float>(neutral_count) / static_cast<float>(total_pixels);
        float neutral_weight = has_neutral_reference ? ClampFloat((neutral_fraction - 0.003f) / 0.045f, 0.35f, 0.82f) : 0.0f;
        float rb_diff = (neutral_rb_diff * neutral_weight) + (parade_rb_diff * (1.0f - neutral_weight));
        rb_diff = ApplyDeadZone(rb_diff, 2.0f);
        float rb_scale = has_neutral_reference ? 0.42f : 0.28f;
        float rb_limit_cool = has_neutral_reference ? -9.0f : -5.0f;
        float rb_limit_warm = has_neutral_reference ? 12.0f : 7.0f;

        if (rb_diff > 0.0f) {
            result.temperature = std::max(rb_limit_cool, -rb_diff * rb_scale);
        } else {
            result.temperature = std::min(rb_limit_warm, -rb_diff * rb_scale);
        }

        float avg_rb = (avg_balance_r + avg_balance_b) * 0.5f;
        float parade_g_diff = static_cast<float>(g_median) - static_cast<float>(r_median + b_median) * 0.5f;
        float neutral_g_diff = avg_balance_g - avg_rb;
        float g_diff = (neutral_g_diff * neutral_weight) + (parade_g_diff * (1.0f - neutral_weight));
        g_diff = ApplyDeadZone(g_diff, 1.5f);
        float tint_scale = has_neutral_reference ? 0.42f : 0.32f;
        float tint_limit = has_neutral_reference ? 8.0f : 6.0f;
        result.tint = g_diff * tint_scale;
        result.tint = std::max(-tint_limit, std::min(tint_limit, result.tint));
    }

    // Calibrated Skin Tone priority
    if (skin_count > 200) {
        float avg_skin_r = static_cast<float>(skin_r_sum) / skin_count;
        float avg_skin_g = static_cast<float>(skin_g_sum) / skin_count;
        float avg_skin_b = static_cast<float>(skin_b_sum) / skin_count;

        float rg_ratio = avg_skin_r / (avg_skin_g + 0.001f);
        if (rg_ratio > 1.45f) {
            result.temperature -= 0.7f;
        } else if (rg_ratio < 1.15f) {
            result.temperature += 1.0f;
            result.tint += 0.5f;
        }
    }

    // Final safety boundaries
    result.temperature = std::max(-10.0f, std::min(13.0f, result.temperature));
    result.tint = std::max(-8.0f, std::min(8.0f, result.tint));

    // Calibrated Saturation
    if (result.is_log) {
        result.saturation = 116.0f;
    } else if (result.is_low_light) {
        result.saturation = 103.0f;
    } else {
        result.saturation = 106.0f;
    }

    // Calibrated Advanced Secondary Grading defaults
    result.vibrance = result.is_log ? 14.0f : 10.0f;
    result.shadows_temp = 0.0f;
    result.shadows_tint = 0.0f;
    result.highlights_temp = 0.0f;
    result.highlights_tint = 0.0f;

    // Confidence
    float confidence = 1.0f;
    if (result.is_low_light) confidence -= 0.15f;
    if (highlight_clip_pct > 0.15f) confidence -= 0.20f;
    if (shadow_crush_pct > 0.15f) confidence -= 0.15f;
    result.confidence = std::max(0.30f, std::min(1.0f, confidence));

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
    std::vector<unsigned char> converted(static_cast<size_t>(width) * static_cast<size_t>(height) * 4u);
    for (int y = 0; y < height; ++y) {
        const float* source = reinterpret_cast<const float*>(
            reinterpret_cast<const unsigned char*>(pixel_buffer) + static_cast<size_t>(y) * row_bytes);
        for (int x = 0; x < width * 4; ++x) {
            const float value = std::isfinite(source[x]) ? source[x] : 0.0f;
            converted[static_cast<size_t>(y) * width * 4u + static_cast<size_t>(x)] =
                static_cast<unsigned char>(ClampFloat(value, 0.0f, 1.0f) * 255.0f + 0.5f);
        }
    }
    return AnalyzeFrame8(converted.data(), width, height, width * 4, result);
}
