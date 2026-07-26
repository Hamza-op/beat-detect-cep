#include "../color_engine.h"
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

    std::vector<unsigned short> pixels16(width * height * 4, 32768);
    assert(ColorEngine{}.AnalyzeFrame16(pixels16.data(), width, height, width * 8, result));
    assert_result(result);

    std::vector<float> pixels32(width * height * 4, 0.5f);
    assert(ColorEngine{}.AnalyzeFrame32(pixels32.data(), width, height, width * 16, result));
    assert_result(result);

    assert(!ColorEngine{}.AnalyzeFrame8(nullptr, width, height, width * 4, result));
    return 0;
}
