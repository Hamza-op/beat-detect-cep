#include "AutoCutColorEngine.h"
#include "../color-core/color_engine.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

struct ColorCorrectionParams {
    float temperature;
    float tint;
    float exposure;
    float contrast;
    float highlights;
    float shadows;
    float whites;
    float blacks;
    float saturation;
    float vibrance;
    float shadows_temp;
    float shadows_tint;
    float highlights_temp;
    float highlights_tint;
    float confidence;
};

struct CapturedAnalysisState {
    A_long version;
    A_Boolean valid;
    float capture_token;
    float capture_seconds;
    A_u_long manual_override_mask;
    ColorCorrectionParams params;
};

static const A_long CAPTURE_STATE_VERSION = 2;

static float Clamp01(float value)
{
    return std::max(0.0f, std::min(1.0f, value));
}

static float Rec709Luma(float r, float g, float b)
{
    return 0.2126f * r + 0.7152f * g + 0.0722f * b;
}

static A_u_char UnitToChannel8(float value)
{
    return static_cast<A_u_char>(std::max(0.0f, std::min(255.0f, value * 255.0f + 0.5f)));
}

static A_u_short UnitToChannel16(float value)
{
    const float max_chan = static_cast<float>(PF_MAX_CHAN16);
    return static_cast<A_u_short>(std::max(0.0f, std::min(max_chan, value * max_chan + 0.5f)));
}

static A_u_char Adobe16ToAnalysis8(A_u_short value)
{
    return UnitToChannel8(Clamp01(static_cast<float>(value) / static_cast<float>(PF_MAX_CHAN16)));
}

static bool GetFloatPixelData(PF_InData* in_data, PF_EffectWorld* world, PF_PixelFloat** pixels)
{
    if (pixels) {
        *pixels = NULL;
    }
    if (!in_data || !in_data->pica_basicP || !world || !pixels) {
        return false;
    }

    const void* raw_suite = NULL;
    if (in_data->pica_basicP->AcquireSuite(kPFPixelDataSuite, kPFPixelDataSuiteVersion2, &raw_suite) != 0 || !raw_suite) {
        return false;
    }

    PF_PixelDataSuite2* pixel_suite = reinterpret_cast<PF_PixelDataSuite2*>(const_cast<void*>(raw_suite));
    PF_Err err = pixel_suite->get_pixel_data_float(world, NULL, pixels);
    in_data->pica_basicP->ReleaseSuite(kPFPixelDataSuite, kPFPixelDataSuiteVersion2);
    return err == PF_Err_NONE && *pixels != NULL;
}

static void RegisterFloatPixelFormat(PF_InData* in_data)
{
    if (!in_data || !in_data->pica_basicP) {
        return;
    }

    const void* raw_suite = NULL;
    if (in_data->pica_basicP->AcquireSuite(kPFPixelFormatSuite, kPFPixelFormatSuiteVersion2, &raw_suite) != 0 || !raw_suite) {
        return;
    }

    PF_PixelFormatSuite2* format_suite = reinterpret_cast<PF_PixelFormatSuite2*>(const_cast<void*>(raw_suite));
    format_suite->PF_AddSupportedPixelFormat(in_data->effect_ref, PF_PixelFormat_ARGB128);
    in_data->pica_basicP->ReleaseSuite(kPFPixelFormatSuite, kPFPixelFormatSuiteVersion2);
}

static bool NearlyEqual(float a, float b)
{
    return std::fabs(a - b) < 0.0001f;
}

static bool IsDefaultParam(PF_ParamDef* const params[], int index, float default_value)
{
    return NearlyEqual(static_cast<float>(params[index]->u.fs_d.value), default_value);
}

static float ParamValue(PF_ParamDef* const params[], int index)
{
    return static_cast<float>(params[index]->u.fs_d.value);
}

static ColorCorrectionParams NeutralColorParams()
{
    ColorCorrectionParams p;
    p.temperature = 0.0f;
    p.tint = 0.0f;
    p.exposure = 0.0f;
    p.contrast = 0.0f;
    p.highlights = 0.0f;
    p.shadows = 0.0f;
    p.whites = 0.0f;
    p.blacks = 0.0f;
    p.saturation = 100.0f;
    p.vibrance = 0.0f;
    p.shadows_temp = 0.0f;
    p.shadows_tint = 0.0f;
    p.highlights_temp = 0.0f;
    p.highlights_tint = 0.0f;
    p.confidence = 1.0f;
    return p;
}

static A_u_long ManualOverrideBit(int index)
{
    if (index < AUTOCUT_TEMPERATURE || index > AUTOCUT_HIGHLIGHTS_TINT) {
        return 0;
    }
    return static_cast<A_u_long>(1u) << static_cast<A_u_long>(index - AUTOCUT_TEMPERATURE);
}

static bool IsManualOverride(
    PF_ParamDef* const params[],
    A_u_long override_mask,
    int index,
    float default_value)
{
    return (override_mask & ManualOverrideBit(index)) != 0 ||
        !IsDefaultParam(params, index, default_value);
}

static CapturedAnalysisState DefaultCaptureState()
{
    CapturedAnalysisState state;
    state.version = CAPTURE_STATE_VERSION;
    state.valid = FALSE;
    state.capture_token = 0.0f;
    state.capture_seconds = 0.0f;
    state.manual_override_mask = 0;
    state.params = NeutralColorParams();
    return state;
}

static ColorCorrectionParams ColorParamsFromAnalysis(const FrameAnalysisResult& analysis)
{
    ColorCorrectionParams p;
    p.temperature = analysis.temperature;
    p.tint = analysis.tint;
    p.exposure = analysis.exposure;
    p.contrast = analysis.contrast;
    p.highlights = analysis.highlights;
    p.shadows = analysis.shadows;
    p.whites = analysis.whites;
    p.blacks = analysis.blacks;
    p.saturation = analysis.saturation;
    p.vibrance = analysis.vibrance;
    p.shadows_temp = analysis.shadows_temp;
    p.shadows_tint = analysis.shadows_tint;
    p.highlights_temp = analysis.highlights_temp;
    p.highlights_tint = analysis.highlights_tint;
    p.confidence = analysis.confidence;
    return p;
}

static void ApplyManualOverrides(
    PF_ParamDef* const params[],
    A_u_long override_mask,
    ColorCorrectionParams& p)
{
    if (IsManualOverride(params, override_mask, AUTOCUT_TEMPERATURE, 0.0f)) p.temperature = ParamValue(params, AUTOCUT_TEMPERATURE);
    if (IsManualOverride(params, override_mask, AUTOCUT_TINT, 0.0f)) p.tint = ParamValue(params, AUTOCUT_TINT);
    if (IsManualOverride(params, override_mask, AUTOCUT_EXPOSURE, 0.0f)) p.exposure = ParamValue(params, AUTOCUT_EXPOSURE);
    if (IsManualOverride(params, override_mask, AUTOCUT_CONTRAST, 0.0f)) p.contrast = ParamValue(params, AUTOCUT_CONTRAST);
    if (IsManualOverride(params, override_mask, AUTOCUT_HIGHLIGHTS, 0.0f)) p.highlights = ParamValue(params, AUTOCUT_HIGHLIGHTS);
    if (IsManualOverride(params, override_mask, AUTOCUT_SHADOWS, 0.0f)) p.shadows = ParamValue(params, AUTOCUT_SHADOWS);
    if (IsManualOverride(params, override_mask, AUTOCUT_WHITES, 0.0f)) p.whites = ParamValue(params, AUTOCUT_WHITES);
    if (IsManualOverride(params, override_mask, AUTOCUT_BLACKS, 0.0f)) p.blacks = ParamValue(params, AUTOCUT_BLACKS);
    if (IsManualOverride(params, override_mask, AUTOCUT_SATURATION, 100.0f)) p.saturation = ParamValue(params, AUTOCUT_SATURATION);
    if (IsManualOverride(params, override_mask, AUTOCUT_VIBRANCE, 0.0f)) p.vibrance = ParamValue(params, AUTOCUT_VIBRANCE);
    if (IsManualOverride(params, override_mask, AUTOCUT_SHADOWS_TEMP, 0.0f)) p.shadows_temp = ParamValue(params, AUTOCUT_SHADOWS_TEMP);
    if (IsManualOverride(params, override_mask, AUTOCUT_SHADOWS_TINT, 0.0f)) p.shadows_tint = ParamValue(params, AUTOCUT_SHADOWS_TINT);
    if (IsManualOverride(params, override_mask, AUTOCUT_HIGHLIGHTS_TEMP, 0.0f)) p.highlights_temp = ParamValue(params, AUTOCUT_HIGHLIGHTS_TEMP);
    if (IsManualOverride(params, override_mask, AUTOCUT_HIGHLIGHTS_TINT, 0.0f)) p.highlights_tint = ParamValue(params, AUTOCUT_HIGHLIGHTS_TINT);
}

static A_u_long GetManualOverrideMask(PF_InData* in_data)
{
    if (!in_data || !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) < sizeof(CapturedAnalysisState)) {
        return 0;
    }
    CapturedAnalysisState* state = reinterpret_cast<CapturedAnalysisState*>(
        PF_LOCK_HANDLE(in_data->sequence_data));
    if (!state) {
        return 0;
    }
    const A_u_long mask = state->version == CAPTURE_STATE_VERSION
        ? state->manual_override_mask
        : 0;
    PF_UNLOCK_HANDLE(in_data->sequence_data);
    return mask;
}

static void UpdateManualOverrideMask(PF_InData* in_data, int param_index)
{
    if (!in_data || !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) < sizeof(CapturedAnalysisState)) {
        return;
    }
    CapturedAnalysisState* state = reinterpret_cast<CapturedAnalysisState*>(
        PF_LOCK_HANDLE(in_data->sequence_data));
    if (!state) {
        return;
    }
    if (state->version != CAPTURE_STATE_VERSION) {
        *state = DefaultCaptureState();
    }
    if (param_index == AUTOCUT_CAPTURE_TOKEN) {
        state->manual_override_mask = 0;
    } else {
        state->manual_override_mask |= ManualOverrideBit(param_index);
    }
    PF_UNLOCK_HANDLE(in_data->sequence_data);
}

static bool ValidateAnalysisDimensions(A_long width, A_long height, size_t& pixel_count)
{
    if (width <= 0 || height <= 0) {
        return false;
    }
    if (width > std::numeric_limits<int>::max() ||
        height > std::numeric_limits<int>::max() ||
        width > std::numeric_limits<int>::max() / 4) {
        return false;
    }
    const size_t w = static_cast<size_t>(width);
    const size_t h = static_cast<size_t>(height);
    if (w > std::numeric_limits<size_t>::max() / h) {
        return false;
    }
    pixel_count = w * h;
    return pixel_count <= std::numeric_limits<size_t>::max() / 4;
}

static bool AnalyzeAdobeLayer(PF_InData* in_data, PF_LayerDef* input_layer, FrameAnalysisResult& analysis)
{
    if (!input_layer || !input_layer->data) {
        return false;
    }
    if (input_layer->rowbytes <= 0) {
        return false;
    }

    size_t pixel_count = 0;
    if (!ValidateAnalysisDimensions(input_layer->width, input_layer->height, pixel_count)) {
        return false;
    }
    PF_PixelFloat* float_pixels = NULL;
    const bool is_float = GetFloatPixelData(in_data, input_layer, &float_pixels);

    if (is_float) {
        if (input_layer->rowbytes / static_cast<A_long>(sizeof(PF_PixelFloat)) < input_layer->width) {
            return false;
        }
    } else if (PF_WORLD_IS_DEEP(input_layer)) {
        if (input_layer->rowbytes / static_cast<A_long>(sizeof(PF_Pixel16)) < input_layer->width) {
            return false;
        }
    } else if (input_layer->rowbytes / static_cast<A_long>(sizeof(PF_Pixel8)) < input_layer->width) {
        return false;
    }

    const char* base = reinterpret_cast<const char*>(input_layer->data);
    ColorEngine engine;

    if (is_float) {
        std::vector<float> rgba(pixel_count * 4);
        for (A_long y = 0; y < input_layer->height; ++y) {
            const PF_PixelFloat* row = reinterpret_cast<const PF_PixelFloat*>(
                reinterpret_cast<const char*>(float_pixels) + (y * input_layer->rowbytes)
            );
            for (A_long x = 0; x < input_layer->width; ++x) {
                const PF_PixelFloat& px = row[x];
                const size_t dst = (static_cast<size_t>(y) * static_cast<size_t>(input_layer->width) + static_cast<size_t>(x)) * 4;
                rgba[dst + 0] = px.red;
                rgba[dst + 1] = px.green;
                rgba[dst + 2] = px.blue;
                rgba[dst + 3] = px.alpha;
            }
        }
        return engine.AnalyzeFrame32(
            rgba.data(),
            static_cast<int>(input_layer->width),
            static_cast<int>(input_layer->height),
            static_cast<int>(static_cast<size_t>(input_layer->width) * 4u * sizeof(float)),
            analysis
        );
    }

    std::vector<unsigned char> rgba(pixel_count * 4);
    if (PF_WORLD_IS_DEEP(input_layer)) {
        for (A_long y = 0; y < input_layer->height; ++y) {
            const PF_Pixel16* row = reinterpret_cast<const PF_Pixel16*>(base + (y * input_layer->rowbytes));
            for (A_long x = 0; x < input_layer->width; ++x) {
                const PF_Pixel16& px = row[x];
                const size_t dst = (static_cast<size_t>(y) * static_cast<size_t>(input_layer->width) + static_cast<size_t>(x)) * 4;
                rgba[dst + 0] = Adobe16ToAnalysis8(px.red);
                rgba[dst + 1] = Adobe16ToAnalysis8(px.green);
                rgba[dst + 2] = Adobe16ToAnalysis8(px.blue);
                rgba[dst + 3] = Adobe16ToAnalysis8(px.alpha);
            }
        }
    } else {
        for (A_long y = 0; y < input_layer->height; ++y) {
            const PF_Pixel8* row = reinterpret_cast<const PF_Pixel8*>(base + (y * input_layer->rowbytes));
            for (A_long x = 0; x < input_layer->width; ++x) {
                const PF_Pixel8& px = row[x];
                const size_t dst = (static_cast<size_t>(y) * static_cast<size_t>(input_layer->width) + static_cast<size_t>(x)) * 4;
                rgba[dst + 0] = px.red;
                rgba[dst + 1] = px.green;
                rgba[dst + 2] = px.blue;
                rgba[dst + 3] = px.alpha;
            }
        }
    }

    return engine.AnalyzeFrame8(
        rgba.data(),
        static_cast<int>(input_layer->width),
        static_cast<int>(input_layer->height),
        static_cast<int>(static_cast<size_t>(input_layer->width) * 4u),
        analysis
    );
}

static bool AnalyzeLayerAtSeconds(PF_InData* in_data, float seconds, FrameAnalysisResult& analysis)
{
    if (!in_data || in_data->time_scale == 0) {
        return false;
    }

    const float safe_seconds = std::max(0.0f, seconds);
    A_long target_time = static_cast<A_long>(safe_seconds * static_cast<float>(in_data->time_scale) + 0.5f);
    if (in_data->total_time > 0) {
        target_time = std::max<A_long>(0, std::min<A_long>(target_time, in_data->total_time));
    }

    PF_ParamDef captured;
    AEFX_CLR_STRUCT(captured);
    PF_Err err = PF_CHECKOUT_PARAM(
        in_data,
        AUTOCUT_INPUT,
        target_time,
        in_data->time_step,
        in_data->time_scale,
        &captured);
    if (err != PF_Err_NONE) {
        return false;
    }

    const bool ok = AnalyzeAdobeLayer(in_data, &captured.u.ld, analysis);
    PF_CHECKIN_PARAM(in_data, &captured);
    return ok;
}

static bool TryGetCapturedParams(PF_InData* in_data, float capture_token, float capture_seconds, ColorCorrectionParams& params)
{
    if (!in_data || !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) < sizeof(CapturedAnalysisState)) {
        return false;
    }

    CapturedAnalysisState* state = reinterpret_cast<CapturedAnalysisState*>(PF_LOCK_HANDLE(in_data->sequence_data));
    if (!state) {
        return false;
    }

    const bool valid =
        state->version == CAPTURE_STATE_VERSION &&
        state->valid &&
        NearlyEqual(state->capture_token, capture_token) &&
        std::fabs(state->capture_seconds - capture_seconds) < 0.001f;
    if (valid) {
        params = state->params;
    }
    PF_UNLOCK_HANDLE(in_data->sequence_data);
    return valid;
}

static void StoreCapturedParams(PF_InData* in_data, float capture_token, float capture_seconds, const ColorCorrectionParams& params)
{
    if (!in_data || !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) < sizeof(CapturedAnalysisState)) {
        return;
    }

    CapturedAnalysisState* state = reinterpret_cast<CapturedAnalysisState*>(PF_LOCK_HANDLE(in_data->sequence_data));
    if (!state) {
        return;
    }
    state->version = CAPTURE_STATE_VERSION;
    state->valid = TRUE;
    state->capture_token = capture_token;
    state->capture_seconds = capture_seconds;
    state->params = params;
    PF_UNLOCK_HANDLE(in_data->sequence_data);
}

static ColorCorrectionParams ResolveAutoColorParams(PF_InData* in_data, PF_ParamDef* const params[], bool& analysis_ok)
{
    ColorCorrectionParams p = NeutralColorParams();
    analysis_ok = true;
    FrameAnalysisResult analysis;
    const float capture_token = ParamValue(params, AUTOCUT_CAPTURE_TOKEN);
    const float capture_seconds = ParamValue(params, AUTOCUT_CAPTURE_SECONDS);

    if (capture_token > 0.5f && capture_seconds >= 0.0f) {
        if (TryGetCapturedParams(in_data, capture_token, capture_seconds, p)) {
            return p;
        }

        if (AnalyzeLayerAtSeconds(in_data, capture_seconds, analysis)) {
            p = ColorParamsFromAnalysis(analysis);
            StoreCapturedParams(in_data, capture_token, capture_seconds, p);
        } else {
            analysis_ok = false;
        }
        return p;
    }

    if (AnalyzeAdobeLayer(in_data, &params[AUTOCUT_INPUT]->u.ld, analysis)) {
        p = ColorParamsFromAnalysis(analysis);
    }
    return p;
}

static float WhiteBalanceProtect(float luma)
{
    if (luma > 0.82f) {
        float t = (luma - 0.82f) / 0.18f;
        t = Clamp01(t);
        return 1.0f - (0.45f * t);
    }
    if (luma < 0.06f) {
        return 0.70f + (0.30f * (luma / 0.06f));
    }
    return 1.0f;
}

static float ClampForDepth(float value, bool preserve_hdr)
{
    return preserve_hdr ? std::max(0.0f, value) : Clamp01(value);
}

static void ClampColorForDepth(float& r, float& g, float& b, bool preserve_hdr)
{
    r = ClampForDepth(r, preserve_hdr);
    g = ClampForDepth(g, preserve_hdr);
    b = ClampForDepth(b, preserve_hdr);
}

static void ApplyColorCorrectionUnit(float& r, float& g, float& b, const ColorCorrectionParams* params, bool preserve_hdr)
{
    const float exp_factor = std::pow(2.0f, params->exposure);
    r *= exp_factor;
    g *= exp_factor;
    b *= exp_factor;

    const float wb_luma_before = Rec709Luma(r, g, b);
    const float wb_protect = WhiteBalanceProtect(wb_luma_before);
    if (params->temperature != 0.0f) {
        const float temp_adj = params->temperature / 100.0f;
        r += temp_adj * 0.28f * wb_protect;
        b -= temp_adj * 0.28f * wb_protect;
    }
    if (params->tint != 0.0f) {
        const float tint_adj = params->tint / 100.0f;
        g -= tint_adj * 0.25f * wb_protect;
        r += tint_adj * 0.12f * wb_protect;
        b += tint_adj * 0.12f * wb_protect;
    }
    const float wb_luma_after = Rec709Luma(r, g, b);
    const float wb_luma_delta = wb_luma_before - wb_luma_after;
    r += wb_luma_delta;
    g += wb_luma_delta;
    b += wb_luma_delta;
    ClampColorForDepth(r, g, b, preserve_hdr);

    float luma = Rec709Luma(r, g, b);
    float display_luma = Clamp01(luma);

    if (params->shadows_temp != 0.0f || params->shadows_tint != 0.0f) {
        const float shadows_temp_adj = params->shadows_temp / 100.0f;
        const float shadows_tint_adj = params->shadows_tint / 100.0f;
        const float factor = 1.0f - display_luma;

        r += shadows_temp_adj * 0.12f * factor;
        b -= shadows_temp_adj * 0.12f * factor;

        g -= shadows_tint_adj * 0.12f * factor;
        r += shadows_tint_adj * 0.06f * factor;
        b += shadows_tint_adj * 0.06f * factor;
    }

    if (params->highlights_temp != 0.0f || params->highlights_tint != 0.0f) {
        const float highlights_temp_adj = params->highlights_temp / 100.0f;
        const float highlights_tint_adj = params->highlights_tint / 100.0f;
        const float factor = display_luma;

        r += highlights_temp_adj * 0.12f * factor;
        b -= highlights_temp_adj * 0.12f * factor;

        g -= highlights_tint_adj * 0.12f * factor;
        r += highlights_tint_adj * 0.06f * factor;
        b += highlights_tint_adj * 0.06f * factor;
    }

    ClampColorForDepth(r, g, b, preserve_hdr);

    if (params->contrast != 0.0f) {
        float c_factor = (100.0f + params->contrast) / 100.0f;
        c_factor = c_factor * c_factor;
        r = (r - 0.5f) * c_factor + 0.5f;
        g = (g - 0.5f) * c_factor + 0.5f;
        b = (b - 0.5f) * c_factor + 0.5f;
    }

    luma = Rec709Luma(r, g, b);
    display_luma = Clamp01(luma);

    if (params->highlights != 0.0f && display_luma > 0.5f) {
        const float hi_factor = (display_luma - 0.5f) * 2.0f;
        const float adj = (params->highlights / 100.0f) * 0.25f * hi_factor;
        r += adj;
        g += adj;
        b += adj;
    }

    if (params->shadows != 0.0f && display_luma < 0.5f) {
        const float sh_factor = (0.5f - display_luma) * 2.0f;
        const float adj = (params->shadows / 100.0f) * 0.25f * sh_factor;
        r += adj;
        g += adj;
        b += adj;
    }

    if (params->whites != 0.0f) {
        const float wh_adj = (params->whites / 100.0f) * 0.15f * (display_luma * display_luma);
        r += wh_adj;
        g += wh_adj;
        b += wh_adj;
    }
    if (params->blacks != 0.0f) {
        const float bl_adj = (params->blacks / 100.0f) * 0.15f * ((1.0f - display_luma) * (1.0f - display_luma));
        r += bl_adj;
        g += bl_adj;
        b += bl_adj;
    }

    ClampColorForDepth(r, g, b, preserve_hdr);
    luma = Rec709Luma(r, g, b);

    if (params->vibrance != 0.0f) {
        const float max_c = std::max({r, g, b});
        const float min_c = std::min({r, g, b});
        const float sat = (max_c > 0.0f) ? ((max_c - min_c) / max_c) : 0.0f;
        float vib_factor = (params->vibrance / 100.0f) * (1.0f - Clamp01(sat));

        const float df = max_c - min_c;
        float h = 0.0f;
        if (df > 0.0f) {
            if (max_c == r) {
                h = 60.0f * fmod(((g - b) / df), 6.0f);
            } else if (max_c == g) {
                h = 60.0f * (((b - r) / df) + 2.0f);
            } else {
                h = 60.0f * (((r - g) / df) + 4.0f);
            }
            if (h < 0.0f) h += 360.0f;
        }

        if (h >= 5.0f && h <= 34.0f) {
            vib_factor *= 0.35f;
        }

        r += (r - luma) * vib_factor;
        g += (g - luma) * vib_factor;
        b += (b - luma) * vib_factor;
    }

    luma = Rec709Luma(r, g, b);
    display_luma = Clamp01(luma);
    float desat_factor = 1.0f;
    if (display_luma < 0.08f) {
        desat_factor = 0.35f + 0.65f * (display_luma / 0.08f);
    } else if (display_luma > 0.995f) {
        desat_factor = 0.80f + 0.20f * ((1.0f - display_luma) / 0.005f);
    }
    desat_factor = Clamp01(desat_factor);
    if (desat_factor < 1.0f) {
        r = luma + (r - luma) * desat_factor;
        g = luma + (g - luma) * desat_factor;
        b = luma + (b - luma) * desat_factor;
    }

    const float max_c = std::max({r, g, b});
    const float min_c = std::min({r, g, b});
    const float df = max_c - min_c;
    float h = 0.0f;
    if (df > 0.0f) {
        if (max_c == r) {
            h = 60.0f * fmod(((g - b) / df), 6.0f);
        } else if (max_c == g) {
            h = 60.0f * (((b - r) / df) + 2.0f);
        } else {
            h = 60.0f * (((r - g) / df) + 4.0f);
        }
        if (h < 0.0f) h += 360.0f;

        luma = Rec709Luma(r, g, b);

        if (h >= 65.0f && h <= 150.0f) {
            g *= 0.95f;
            r = luma + (r - luma) * 0.96f;
            g = luma + (g - luma) * 0.96f;
            b = luma + (b - luma) * 0.96f;
        } else if (h >= 180.0f && h <= 250.0f) {
            r = luma + (r - luma) * 1.06f;
            g = luma + (g - luma) * 1.06f;
            b = luma + (b - luma) * 1.06f;
        }
    }

    if (params->saturation != 100.0f) {
        const float updated_luma = Rec709Luma(r, g, b);
        const float sat_factor = params->saturation / 100.0f;
        r = updated_luma + (r - updated_luma) * sat_factor;
        g = updated_luma + (g - updated_luma) * sat_factor;
        b = updated_luma + (b - updated_luma) * sat_factor;
    }

    ClampColorForDepth(r, g, b, preserve_hdr);
}

static PF_Err
ApplyColorCorrection8(
    void        *refcon, 
    A_long      xL, 
    A_long      yL, 
    PF_Pixel8   *inP, 
    PF_Pixel8   *outP)
{
    ColorCorrectionParams *params = reinterpret_cast<ColorCorrectionParams*>(refcon);

    float r = inP->red / 255.0f;
    float g = inP->green / 255.0f;
    float b = inP->blue / 255.0f;

    ApplyColorCorrectionUnit(r, g, b, params, false);

    outP->alpha = inP->alpha;
    outP->red   = UnitToChannel8(r);
    outP->green = UnitToChannel8(g);
    outP->blue  = UnitToChannel8(b);

    return PF_Err_NONE;
}

static PF_Err
ApplyColorCorrection16(
    void        *refcon, 
    A_long      xL, 
    A_long      yL, 
    PF_Pixel16  *inP, 
    PF_Pixel16  *outP)
{
    ColorCorrectionParams *params = reinterpret_cast<ColorCorrectionParams*>(refcon);
    
    // Adobe PF_Pixel16 uses PF_MAX_CHAN16, not the full unsigned-short range.
    const float max_chan = static_cast<float>(PF_MAX_CHAN16);
    float r = inP->red / max_chan;
    float g = inP->green / max_chan;
    float b = inP->blue / max_chan;

    ApplyColorCorrectionUnit(r, g, b, params, false);

    outP->alpha = inP->alpha;
    outP->red   = UnitToChannel16(r);
    outP->green = UnitToChannel16(g);
    outP->blue  = UnitToChannel16(b);

    return PF_Err_NONE;
}

// 32-bpc float Pixel Processing Function
static PF_Err
ApplyColorCorrection32(
    void            *refcon,
    A_long          xL,
    A_long          yL,
    PF_PixelFloat   *inP,
    PF_PixelFloat   *outP)
{
    ColorCorrectionParams *params = reinterpret_cast<ColorCorrectionParams*>(refcon);

    float r = inP->red;
    float g = inP->green;
    float b = inP->blue;

    ApplyColorCorrectionUnit(r, g, b, params, true);

    outP->alpha = inP->alpha;
    outP->red = r;
    outP->green = g;
    outP->blue = b;

    return PF_Err_NONE;
}

static PF_Err 
About(  
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output)
{
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    
    suites.ANSICallbacksSuite1()->sprintf(
        out_data->return_msg,
        "%s v%d.%d.%d\r%s",
        STR(StrID_Name),
        MAJOR_VERSION,
        MINOR_VERSION,
        BUG_VERSION,
        STR(StrID_Description));
        
    return PF_Err_NONE;
}

static PF_Err 
GlobalSetup(    
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output)
{
    out_data->my_version = PF_VERSION(  MAJOR_VERSION, 
                                        MINOR_VERSION,
                                        BUG_VERSION, 
                                        STAGE_VERSION, 
                                        BUILD_VERSION);

    out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE;
    out_data->out_flags2 = PF_OutFlag2_FLOAT_COLOR_AWARE | PF_OutFlag2_MUTABLE_RENDER_SEQUENCE_DATA_SLOWER;
    RegisterFloatPixelFormat(in_data);
    
    return PF_Err_NONE;
}

static PF_Err
AddInternalFloatSlider(
    PF_InData* in_data,
    PF_ParamDef& def,
    const char* name,
    float valid_min,
    float valid_max,
    float default_value,
    A_long disk_id)
{
    AEFX_CLR_STRUCT(def);
    def.param_type = PF_Param_FLOAT_SLIDER;
    PF_STRNNCPY(def.PF_DEF_NAME, name, sizeof(def.PF_DEF_NAME));
    def.u.fs_d.valid_min = static_cast<PF_FpShort>(valid_min);
    def.u.fs_d.slider_min = static_cast<PF_FpShort>(valid_min);
    def.u.fs_d.valid_max = static_cast<PF_FpShort>(valid_max);
    def.u.fs_d.slider_max = static_cast<PF_FpShort>(valid_max);
    def.u.fs_d.value = static_cast<PF_FpShort>(default_value);
    def.u.fs_d.dephault = static_cast<PF_FpShort>(default_value);
    def.u.fs_d.precision = PF_Precision_HUNDREDTHS;
    def.flags = PF_ParamFlag_CANNOT_TIME_VARY;
    def.ui_flags = PF_PUI_NONE;
    def.uu.id = disk_id;
    return PF_ADD_PARAM(in_data, -1, &def);
}

static PF_Err
SequenceSetup(
    PF_InData* in_data,
    PF_OutData* out_data)
{
    PF_Handle handle = PF_NEW_HANDLE(sizeof(CapturedAnalysisState));
    if (!handle) {
        return PF_Err_OUT_OF_MEMORY;
    }

    CapturedAnalysisState* state = reinterpret_cast<CapturedAnalysisState*>(PF_LOCK_HANDLE(handle));
    if (!state) {
        PF_DISPOSE_HANDLE(handle);
        return PF_Err_OUT_OF_MEMORY;
    }
    *state = DefaultCaptureState();
    PF_UNLOCK_HANDLE(handle);
    out_data->sequence_data = handle;
    return PF_Err_NONE;
}

static PF_Err
SequenceResetup(
    PF_InData* in_data,
    PF_OutData* out_data)
{
    if (in_data && in_data->sequence_data &&
        PF_GET_HANDLE_SIZE(in_data->sequence_data) >= sizeof(CapturedAnalysisState)) {
        out_data->sequence_data = in_data->sequence_data;
        return PF_Err_NONE;
    }
    return SequenceSetup(in_data, out_data);
}

static PF_Err
SequenceSetdown(
    PF_InData* in_data)
{
    if (in_data && in_data->sequence_data) {
        PF_DISPOSE_HANDLE(in_data->sequence_data);
    }
    return PF_Err_NONE;
}

static PF_Err 
ParamsSetup(    
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output)
{
    PF_Err      err     = PF_Err_NONE;
    PF_ParamDef def;    

    // 1. Temperature
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Temp_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, TEMP_DISK_ID);

    // 2. Tint
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Tint_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, TINT_DISK_ID);

    // 3. Exposure
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Exposure_Param_Name), -5, 5, -5, 5, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, EXPOSURE_DISK_ID);

    // 4. Contrast
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Contrast_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, CONTRAST_DISK_ID);

    // 5. Highlights
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Highlights_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, HIGHLIGHTS_DISK_ID);

    // 6. Shadows
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Shadows_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, SHADOWS_DISK_ID);

    // 7. Whites
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Whites_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, WHITES_DISK_ID);

    // 8. Blacks
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Blacks_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, BLACKS_DISK_ID);

    // 9. Saturation
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Saturation_Param_Name), 0, 200, 0, 200, 100,
                          PF_Precision_HUNDREDTHS, 0, 0, SATURATION_DISK_ID);

    // 10. Vibrance (Advanced)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Vibrance_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, VIBRANCE_DISK_ID);

    // 11. Shadows Temp (Lift)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_ShadowsTemp_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, SHADOWS_TEMP_DISK_ID);

    // 12. Shadows Tint (Lift)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_ShadowsTint_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, SHADOWS_TINT_DISK_ID);

    // 13. Highlights Temp (Gain)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_HighlightsTemp_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, HIGHLIGHTS_TEMP_DISK_ID);

    // 14. Highlights Tint (Gain)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_HighlightsTint_Param_Name), -100, 100, -100, 100, 0,
                          PF_Precision_HUNDREDTHS, 0, 0, HIGHLIGHTS_TINT_DISK_ID);

    // 15. Auto Trigger Button
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON(STR(StrID_AutoTrigger_Param_Name), "Refresh Auto Analysis", 0,
                  PF_ParamFlag_SUPERVISE | PF_ParamFlag_CANNOT_TIME_VARY,
                  AUTO_TRIGGER_DISK_ID);

    // 16. Keep the historical disk ID for project compatibility, but do not
    // expose confidence until the host can report a truthful value.
    AEFX_CLR_STRUCT(def);
    def.flags = PF_ParamFlag_CANNOT_TIME_VARY;
    def.ui_flags = PF_PUI_INVISIBLE;
    PF_ADD_FLOAT_SLIDER(STR(StrID_Confidence_Param_Name), 0, 100, 0, 100,
                        AEFX_DEFAULT_CURVE_TOLERANCE, 100,
                        PF_Precision_HUNDREDTHS, 0, false,
                        CONFIDENCE_DISK_ID);

    err = AddInternalFloatSlider(in_data, def, STR(StrID_CaptureToken_Param_Name),
                               0.0f, 1000000.0f, 0.0f, CAPTURE_TOKEN_DISK_ID);
    if (err != PF_Err_NONE) {
        return err;
    }

    err = AddInternalFloatSlider(in_data, def, STR(StrID_CaptureSeconds_Param_Name),
                               0.0f, 86400.0f, 0.0f, CAPTURE_SECONDS_DISK_ID);
    if (err != PF_Err_NONE) {
        return err;
    }

    err = AddInternalFloatSlider(in_data, def, STR(StrID_AutoAmount_Param_Name),
                               0.0f, 100.0f, 100.0f, AUTO_AMOUNT_DISK_ID);
    if (err != PF_Err_NONE) {
        return err;
    }
    
    out_data->num_params = AUTOCUT_NUM_PARAMS;

    return err;
}

static PF_Err 
Render(
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output)
{
    PF_Err              err     = PF_Err_NONE;
    AEGP_SuiteHandler   suites(in_data->pica_basicP);

    err = PF_COPY(&params[AUTOCUT_INPUT]->u.ld, output, NULL, NULL);
    if (err != PF_Err_NONE) {
        return err;
    }

    bool analysis_ok = false;
    ColorCorrectionParams p = ResolveAutoColorParams(in_data, params, analysis_ok);
    if (!analysis_ok) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }
    // Low-confidence frames still receive a useful starting grade, but the
    // most aggressive automatic changes are softened when the solver had
    // poor exposure or color references to work from.
    const float analysis_confidence = Clamp01(p.confidence);
    const float confidence_amount = 0.60f + (0.40f * analysis_confidence);
    const float auto_amount =
        Clamp01(ParamValue(params, AUTOCUT_AUTO_AMOUNT) / 100.0f) * confidence_amount;
    const ColorCorrectionParams neutral = NeutralColorParams();
    p.temperature *= auto_amount;
    p.tint *= auto_amount;
    p.exposure *= auto_amount;
    p.contrast *= auto_amount;
    p.highlights *= auto_amount;
    p.shadows *= auto_amount;
    p.whites *= auto_amount;
    p.blacks *= auto_amount;
    p.saturation = neutral.saturation + (p.saturation - neutral.saturation) * auto_amount;
    p.vibrance *= auto_amount;
    p.shadows_temp *= auto_amount;
    p.shadows_tint *= auto_amount;
    p.highlights_temp *= auto_amount;
    p.highlights_tint *= auto_amount;
    ApplyManualOverrides(params, GetManualOverrideMask(in_data), p);

    A_long linesL = output->extent_hint.bottom - output->extent_hint.top;
    if (linesL <= 0) {
        return PF_Err_NONE;
    }

    PF_PixelFloat* float_output = NULL;
    if (GetFloatPixelData(in_data, output, &float_output)) {
        err = suites.IterateFloatSuite2()->iterate(in_data,
                                                   0,
                                                   linesL,
                                                   &params[AUTOCUT_INPUT]->u.ld,
                                                   NULL,
                                                   (void*)&p,
                                                   ApplyColorCorrection32,
                                                   output);
    } else if (PF_WORLD_IS_DEEP(output)) {
        err = suites.Iterate16Suite2()->iterate(  in_data,
                                                  0,
                                                  linesL,
                                                  &params[AUTOCUT_INPUT]->u.ld,
                                                  NULL,
                                                  (void*)&p,
                                                  ApplyColorCorrection16,
                                                  output);
    } else {
        err = suites.Iterate8Suite2()->iterate(   in_data,
                                                  0,
                                                  linesL,
                                                  &params[AUTOCUT_INPUT]->u.ld,
                                                  NULL,
                                                  (void*)&p,
                                                  ApplyColorCorrection8,
                                                  output);
    }

    if (err != PF_Err_NONE) {
        return err;
    }
    return PF_Err_NONE;
}

static PF_Err
UserChangedParam(
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output,
    void            *extra)
{
    PF_UserChangedParamExtra* changed = reinterpret_cast<PF_UserChangedParamExtra*>(extra);
    if (changed) {
        UpdateManualOverrideMask(in_data, changed->param_index);
        if (
            changed->param_index == AUTOCUT_AUTO_TRIGGER ||
            changed->param_index == AUTOCUT_CAPTURE_TOKEN ||
            ManualOverrideBit(changed->param_index) != 0
        ) {
            out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
        }
    }
    return PF_Err_NONE;
}

extern "C" DllExport
PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr,
    PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite* inSPBasicSuitePtr,
    const char* inHostName,
    const char* inHostVersion)
{
    PF_Err result = PF_Err_INVALID_CALLBACK;

    result = PF_REGISTER_EFFECT_EXT2(
        inPtr,
        inPluginDataCallBackPtr,
        "AutoCutStudio Color Engine",
        "ADBE AutoCutColorEngine",
        "AutoCut Studio",
        AE_RESERVED_INFO,
        "EffectMain",
        "https://github.com/Hamza-op/autocut-studio");

    return result;
}

PF_Err
EffectMain(
    PF_Cmd          cmd,
    PF_InData       *in_data,
    PF_OutData      *out_data,
    PF_ParamDef     *params[],
    PF_LayerDef     *output,
    void            *extra)
{
    PF_Err      err = PF_Err_NONE;
    
    try {
        switch (cmd) {
            case PF_Cmd_ABOUT:
                err = About(in_data, out_data, params, output);
                break;
                
            case PF_Cmd_GLOBAL_SETUP:
                err = GlobalSetup(in_data, out_data, params, output);
                break;
                
            case PF_Cmd_PARAMS_SETUP:
                err = ParamsSetup(in_data, out_data, params, output);
                break;

            case PF_Cmd_SEQUENCE_SETUP:
                err = SequenceSetup(in_data, out_data);
                break;

            case PF_Cmd_SEQUENCE_RESETUP:
                err = SequenceResetup(in_data, out_data);
                break;

            case PF_Cmd_SEQUENCE_SETDOWN:
                err = SequenceSetdown(in_data);
                break;
                
            case PF_Cmd_RENDER:
                err = Render(in_data, out_data, params, output);
                break;

            case PF_Cmd_USER_CHANGED_PARAM:
                err = UserChangedParam(in_data, out_data, params, output, extra);
                break;
        }
    }
    catch (PF_Err &thrown_err) {
        err = thrown_err;
    }
    return err;
}

