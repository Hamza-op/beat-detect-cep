#include "../color_engine.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <vector>

static void assert_result(const FrameAnalysisResult& result) {
    assert(std::isfinite(result.exposure));
    assert(result.confidence >= 0.30f && result.confidence <= 1.0f);
}

int main() {
    const int width = 8;
    const int height = 8;
    std::vector<unsigned char> pixels8(width * height * 4, 128);
    FrameAnalysisResult result{};
    assert(ColorEngine{}.AnalyzeFrame8(pixels8.data(), width, height, width * 4, result));
    assert_result(result);
    assert(!result.is_log);

    std::vector<unsigned short> pixels16(width * height * 4, 32768);
    assert(ColorEngine{}.AnalyzeFrame16(pixels16.data(), width, height, width * 8, result));
    assert_result(result);

    std::vector<float> pixels32(width * height * 4, 0.5f);
    for (size_t i = 3; i < pixels32.size(); i += 4) {
        pixels32[i] = 1.0f;
    }
    assert(ColorEngine{}.AnalyzeFrame32(pixels32.data(), width, height, width * 16, result));
    assert_result(result);

    {
        // Float analysis must retain scene-referred highlight separation above
        // 1.0 instead of making it identical to a hard-clipped SDR frame.
        const int hdr_width = 32;
        const int hdr_height = 16;
        std::vector<float> hdr(hdr_width * hdr_height * 4, 1.0f);
        std::vector<float> clipped(hdr_width * hdr_height * 4, 1.0f);
        for (int y = 0; y < hdr_height; ++y) {
            for (int x = 0; x < hdr_width; ++x) {
                const size_t offset =
                    (static_cast<size_t>(y) * hdr_width + static_cast<size_t>(x)) * 4;
                const float value = x < 8 ? 0.35f : (x < 16 ? 1.2f : (x < 24 ? 2.0f : 4.0f));
                hdr[offset + 0] = value;
                hdr[offset + 1] = value * 0.96f;
                hdr[offset + 2] = value * 0.90f;
                hdr[offset + 3] = 1.0f;
                clipped[offset + 0] = std::min(1.0f, hdr[offset + 0]);
                clipped[offset + 1] = std::min(1.0f, hdr[offset + 1]);
                clipped[offset + 2] = std::min(1.0f, hdr[offset + 2]);
                clipped[offset + 3] = 1.0f;
            }
        }
        FrameAnalysisResult hdr_result{};
        FrameAnalysisResult clipped_result{};
        assert(ColorEngine{}.AnalyzeFrame32(
            hdr.data(), hdr_width, hdr_height, hdr_width * 16, hdr_result));
        assert(ColorEngine{}.AnalyzeFrame32(
            clipped.data(), hdr_width, hdr_height, hdr_width * 16, clipped_result));
        assert_result(hdr_result);
        assert_result(clipped_result);
        assert(
            std::fabs(hdr_result.exposure - clipped_result.exposure) > 0.001f ||
            std::fabs(hdr_result.highlights - clipped_result.highlights) > 0.001f ||
            std::fabs(hdr_result.whites - clipped_result.whites) > 0.001f
        );
    }

    assert(!ColorEngine{}.AnalyzeFrame8(nullptr, width, height, width * 4, result));

    {
        // Letterboxed footage should be judged from the active image, not the
        // black bars surrounding it.
        const int boxed_width = 16;
        const int boxed_height = 16;
        std::vector<unsigned char> letterboxed(
            boxed_width * boxed_height * 4,
            0
        );
        for (int y = 4; y < 12; ++y) {
            for (int x = 0; x < boxed_width; ++x) {
                const size_t offset =
                    (static_cast<size_t>(y) * boxed_width + static_cast<size_t>(x)) * 4;
                letterboxed[offset + 0] = 128;
                letterboxed[offset + 1] = 128;
                letterboxed[offset + 2] = 128;
                letterboxed[offset + 3] = 255;
            }
        }
        assert(ColorEngine{}.AnalyzeFrame8(
            letterboxed.data(),
            boxed_width,
            boxed_height,
            boxed_width * 4,
            result
        ));
        assert(result.exposure > -0.10f && result.exposure < 0.10f);
        assert(!result.is_log);
    }

    {
        // A saturated stage light is not a neutral-white reference. The
        // analyzer should avoid inventing a large white-balance correction.
        const int cast_width = 32;
        const int cast_height = 32;
        std::vector<unsigned char> red_cast(cast_width * cast_height * 4, 255);
        for (int y = 0; y < cast_height; ++y) {
            for (int x = 0; x < cast_width; ++x) {
                const size_t offset =
                    (static_cast<size_t>(y) * cast_width + static_cast<size_t>(x)) * 4;
                red_cast[offset + 0] = 200;
                red_cast[offset + 1] = 40;
                red_cast[offset + 2] = 30;
                red_cast[offset + 3] = 255;
            }
        }
        assert(ColorEngine{}.AnalyzeFrame8(
            red_cast.data(),
            cast_width,
            cast_height,
            cast_width * 4,
            result
        ));
        assert(std::fabs(result.temperature) < 0.5f);
        assert(std::fabs(result.tint) < 0.5f);
        assert(result.confidence < 0.90f);
    }

    {
        // Clipped/blocked footage should expose lower confidence and recover
        // the extremes conservatively instead of receiving a full-strength
        // automatic grade.
        const int extreme_width = 32;
        const int extreme_height = 32;
        std::vector<unsigned char> extremes(
            extreme_width * extreme_height * 4,
            255
        );
        for (int y = 0; y < extreme_height / 2; ++y) {
            for (int x = 0; x < extreme_width; ++x) {
                const size_t offset =
                    (static_cast<size_t>(y) * extreme_width + static_cast<size_t>(x)) * 4;
                extremes[offset + 0] = 0;
                extremes[offset + 1] = 0;
                extremes[offset + 2] = 0;
                extremes[offset + 3] = 255;
            }
        }
        assert(ColorEngine{}.AnalyzeFrame8(
            extremes.data(),
            extreme_width,
            extreme_height,
            extreme_width * 4,
            result
        ));
        assert(result.confidence <= 0.80f);
        assert(result.highlights < 0.0f);
    }

    {
        // Wedding-style composition: bright neutral walls/clothing, skin
        // tones, and a darker suit should produce a restrained starting grade.
        const int wedding_width = 32;
        const int wedding_height = 24;
        std::vector<unsigned char> wedding(
            wedding_width * wedding_height * 4,
            0
        );
        for (int y = 0; y < wedding_height; ++y) {
            for (int x = 0; x < wedding_width; ++x) {
                const size_t offset =
                    (static_cast<size_t>(y) * wedding_width + static_cast<size_t>(x)) * 4;
                unsigned char r = 210;
                unsigned char g = 210;
                unsigned char b = 210;
                if (x < 8) {
                    r = 154;
                    g = 103;
                    b = 83;
                } else if (x >= 22) {
                    r = 52;
                    g = 50;
                    b = 48;
                } else if (y > 15) {
                    r = 228;
                    g = 215;
                    b = 190;
                }
                wedding[offset + 0] = r;
                wedding[offset + 1] = g;
                wedding[offset + 2] = b;
                wedding[offset + 3] = 255;
            }
        }
        assert(ColorEngine{}.AnalyzeFrame8(
            wedding.data(),
            wedding_width,
            wedding_height,
            wedding_width * 4,
            result
        ));
        assert(result.exposure < 0.0f);
        assert(std::fabs(result.temperature) < 5.0f);
        assert(std::fabs(result.tint) < 5.0f);
        assert(result.confidence >= 0.70f);
    }

    return 0;
}
