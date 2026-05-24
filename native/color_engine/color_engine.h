#pragma once

#ifndef COLOR_ENGINE_H
#define COLOR_ENGINE_H

#include <vector>

struct FrameAnalysisResult {
    float exposure;       // -150 to 150 (mapped to slider)
    float contrast;       // -100 to 100
    float highlights;     // -100 to 100
    float shadows;        // -100 to 100
    float whites;         // -100 to 100
    float blacks;         // -100 to 100
    float saturation;     // 0 to 200 (100 is neutral)
    float temperature;    // -100 to 100
    float tint;           // -100 to 100
    float vibrance;       // -100 to 100
    float shadows_temp;   // -100 to 100
    float shadows_tint;   // -100 to 100
    float highlights_temp;// -100 to 100
    float highlights_tint;// -100 to 100
    float confidence;     // 0.0 to 1.0 (how confident the solver is)
    bool is_log;          // Detected log/flat footage
    bool is_low_light;    // Detected underexposed/low-light scene
};

class ColorEngine {
public:
    ColorEngine() = default;
    ~ColorEngine() = default;

    // Analyzes a standard RGBA 8-bpc (32-bit) pixel buffer
    bool AnalyzeFrame8(
        const unsigned char* pixel_buffer,
        int width,
        int height,
        int row_bytes,
        FrameAnalysisResult& result
    );

    // Analyzes a standard RGBA 16-bpc (64-bit) pixel buffer
    bool AnalyzeFrame16(
        const unsigned short* pixel_buffer,
        int width,
        int height,
        int row_bytes,
        FrameAnalysisResult& result
    );
};

#endif // COLOR_ENGINE_H
