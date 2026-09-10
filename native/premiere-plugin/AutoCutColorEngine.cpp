#include "AutoCutColorEngine.h"
#include "../color-core/color_engine.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <stdexcept>
#include <type_traits>
#include <vector>

/*
 * Integration requirements:
 *
 * - Retains the existing parameter order, disk IDs, and effect match name.
 * - Uses the existing legacy render path; does not advertise Smart Render
 *   or Multi-Frame Rendering support.
 * - Only ARGB worlds represented by PF_Pixel8, PF_Pixel16, or PF_PixelFloat
 *   are supported. Do not register BGRA/YUV formats without adding adapters.
 * - Verify PixelDataSuite/PixelFormatSuite availability with the SDK and host
 *   versions targeted by the plugin.
 *
 * Alpha contract:
 *
 * Adobe effect worlds are commonly associated/premultiplied. This adapter
 * unpremultiplies for analysis and correction, then reassociates output.
 * Change the setting below if the negotiated host format is straight alpha.
 * Alpha association cannot be reliably inferred from pixel values.
 *
 * Time contract:
 *
 * Capture Seconds is measured in the time coordinate accepted by
 * PF_CHECKOUT_PARAM for this effect input. Timeline-relative seconds from
 * the panel must be mapped correctly by the host integration. This file
 * cannot infer timeline placement, source trims, or time-remapping metadata.
 *
 * Behavior:
 *
 * - Requested capture failures never fall back to a different frame.
 * - Auto Amount == 0 skips automatic analysis.
 * - Public color controls are offsets to the automatic base correction.
 * - Neutral controls are a true pixel-preserving bypass.
 * - Unconditional "film look" recoloring has been removed.
 * - Float output preserves finite negative and super-white values.
 *
 * Capture sequence data contains only values, never pointers or mutexes.
 * Sequence-handle access is serialized within this plugin module. Host
 * lifecycle synchronization is still required; handle locking alone is not
 * a substitute for the host's render/lifecycle contract.
 */

namespace {

constexpr bool kPixelsArePremultiplied = true;
constexpr double kMinimumAlpha = 1.0e-6;
constexpr A_long kCaptureStateVersion = 3;

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

/*
 * Layout retained from the previous state structure.
 * manual_override_mask is reserved for compatibility and is no longer used.
 * Public parameters now consistently act as offsets.
 */
struct CapturedAnalysisState {
    A_long version;
    A_Boolean valid;
    float capture_token;
    float capture_seconds;
    A_u_long manual_override_mask;
    ColorCorrectionParams params;
};

static_assert(
    std::is_trivially_copyable<CapturedAnalysisState>::value,
    "Sequence state must remain trivially copyable."
);

struct ColorControl {
    int index;
    const char* name;
    float minimum;
    float maximum;
    float neutral;
    A_long disk_id;
    float ColorCorrectionParams::* member;
};

std::mutex gCaptureStateMutex;

template <typename T>
T Clamp(T value, T minimum, T maximum)
{
    return std::max(minimum, std::min(maximum, value));
}

double FiniteOr(double value, double fallback)
{
    return std::isfinite(value) ? value : fallback;
}

float SafeFloat(double value, double fallback = 0.0)
{
    if (!std::isfinite(value)) {
        return static_cast<float>(fallback);
    }

    const double limit =
        static_cast<double>(std::numeric_limits<float>::max());

    return static_cast<float>(Clamp(value, -limit, limit));
}

double Clamp01(double value)
{
    return Clamp(FiniteOr(value, 0.0), 0.0, 1.0);
}

double Rec709Luma(double r, double g, double b)
{
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

ColorCorrectionParams NeutralColorParams()
{
    ColorCorrectionParams result{};
    result.saturation = 100.0f;
    result.confidence = 0.0f;
    return result;
}

CapturedAnalysisState DefaultCaptureState()
{
    CapturedAnalysisState result{};
    result.version = kCaptureStateVersion;
    result.valid = FALSE;
    result.params = NeutralColorParams();
    return result;
}

std::vector<ColorControl> ColorControls()
{
    return {
        {
            AUTOCUT_TEMPERATURE,
            STR(StrID_Temp_Param_Name),
            -100.0f, 100.0f, 0.0f, TEMP_DISK_ID,
            &ColorCorrectionParams::temperature
        },
        {
            AUTOCUT_TINT,
            STR(StrID_Tint_Param_Name),
            -100.0f, 100.0f, 0.0f, TINT_DISK_ID,
            &ColorCorrectionParams::tint
        },
        {
            AUTOCUT_EXPOSURE,
            STR(StrID_Exposure_Param_Name),
            -5.0f, 5.0f, 0.0f, EXPOSURE_DISK_ID,
            &ColorCorrectionParams::exposure
        },
        {
            AUTOCUT_CONTRAST,
            STR(StrID_Contrast_Param_Name),
            -100.0f, 100.0f, 0.0f, CONTRAST_DISK_ID,
            &ColorCorrectionParams::contrast
        },
        {
            AUTOCUT_HIGHLIGHTS,
            STR(StrID_Highlights_Param_Name),
            -100.0f, 100.0f, 0.0f, HIGHLIGHTS_DISK_ID,
            &ColorCorrectionParams::highlights
        },
        {
            AUTOCUT_SHADOWS,
            STR(StrID_Shadows_Param_Name),
            -100.0f, 100.0f, 0.0f, SHADOWS_DISK_ID,
            &ColorCorrectionParams::shadows
        },
        {
            AUTOCUT_WHITES,
            STR(StrID_Whites_Param_Name),
            -100.0f, 100.0f, 0.0f, WHITES_DISK_ID,
            &ColorCorrectionParams::whites
        },
        {
            AUTOCUT_BLACKS,
            STR(StrID_Blacks_Param_Name),
            -100.0f, 100.0f, 0.0f, BLACKS_DISK_ID,
            &ColorCorrectionParams::blacks
        },
        {
            AUTOCUT_SATURATION,
            STR(StrID_Saturation_Param_Name),
            0.0f, 200.0f, 100.0f, SATURATION_DISK_ID,
            &ColorCorrectionParams::saturation
        },
        {
            AUTOCUT_VIBRANCE,
            STR(StrID_Vibrance_Param_Name),
            -100.0f, 100.0f, 0.0f, VIBRANCE_DISK_ID,
            &ColorCorrectionParams::vibrance
        },
        {
            AUTOCUT_SHADOWS_TEMP,
            STR(StrID_ShadowsTemp_Param_Name),
            -100.0f, 100.0f, 0.0f, SHADOWS_TEMP_DISK_ID,
            &ColorCorrectionParams::shadows_temp
        },
        {
            AUTOCUT_SHADOWS_TINT,
            STR(StrID_ShadowsTint_Param_Name),
            -100.0f, 100.0f, 0.0f, SHADOWS_TINT_DISK_ID,
            &ColorCorrectionParams::shadows_tint
        },
        {
            AUTOCUT_HIGHLIGHTS_TEMP,
            STR(StrID_HighlightsTemp_Param_Name),
            -100.0f, 100.0f, 0.0f, HIGHLIGHTS_TEMP_DISK_ID,
            &ColorCorrectionParams::highlights_temp
        },
        {
            AUTOCUT_HIGHLIGHTS_TINT,
            STR(StrID_HighlightsTint_Param_Name),
            -100.0f, 100.0f, 0.0f, HIGHLIGHTS_TINT_DISK_ID,
            &ColorCorrectionParams::highlights_tint
        }
    };
}

bool ValidParameters(PF_ParamDef* const params[])
{
    if (!params) {
        return false;
    }

    for (int i = 0; i < AUTOCUT_NUM_PARAMS; ++i) {
        if (!params[i]) {
            return false;
        }
    }

    return true;
}

bool ReadFiniteParam(
    PF_ParamDef* const params[],
    int index,
    float& value
)
{
    if (
        !params ||
        index < 0 ||
        index >= AUTOCUT_NUM_PARAMS ||
        !params[index]
    ) {
        return false;
    }

    const double raw = params[index]->u.fs_d.value;

    if (
        !std::isfinite(raw) ||
        std::fabs(raw) > std::numeric_limits<float>::max()
    ) {
        return false;
    }

    value = static_cast<float>(raw);
    return true;
}

float ParamValue(
    PF_ParamDef* const params[],
    int index,
    float fallback
)
{
    float value = fallback;
    return ReadFiniteParam(params, index, value) ? value : fallback;
}

ColorCorrectionParams ColorParamsFromAnalysis(
    const FrameAnalysisResult& analysis
)
{
    ColorCorrectionParams result{};
    result.temperature = analysis.temperature;
    result.tint = analysis.tint;
    result.exposure = analysis.exposure;
    result.contrast = analysis.contrast;
    result.highlights = analysis.highlights;
    result.shadows = analysis.shadows;
    result.whites = analysis.whites;
    result.blacks = analysis.blacks;
    result.saturation = analysis.saturation;
    result.vibrance = analysis.vibrance;
    result.shadows_temp = analysis.shadows_temp;
    result.shadows_tint = analysis.shadows_tint;
    result.highlights_temp = analysis.highlights_temp;
    result.highlights_tint = analysis.highlights_tint;
    result.confidence = analysis.confidence;
    return result;
}

bool ParamsAreFinite(const ColorCorrectionParams& params)
{
    const float values[] = {
        params.temperature, params.tint, params.exposure,
        params.contrast, params.highlights, params.shadows,
        params.whites, params.blacks, params.saturation,
        params.vibrance, params.shadows_temp, params.shadows_tint,
        params.highlights_temp, params.highlights_tint, params.confidence
    };

    for (float value : values) {
        if (!std::isfinite(value)) {
            return false;
        }
    }

    return true;
}

/*
 * Adobe suite lifetime.
 */

class SuiteLease {
public:
    SuiteLease(
        SPBasicSuite* basic,
        const char* name,
        A_long version
    )
        : basic_(basic),
          name_(name),
          version_(version),
          suite_(nullptr)
    {
        if (
            basic_ &&
            basic_->AcquireSuite(name_, version_, &suite_) != 0
        ) {
            suite_ = nullptr;
        }
    }

    ~SuiteLease()
    {
        if (basic_ && suite_) {
            basic_->ReleaseSuite(name_, version_);
        }
    }

    SuiteLease(const SuiteLease&) = delete;
    SuiteLease& operator=(const SuiteLease&) = delete;

    template <typename T>
    const T* Get() const
    {
        return static_cast<const T*>(suite_);
    }

private:
    SPBasicSuite* basic_;
    const char* name_;
    A_long version_;
    const void* suite_;
};

bool GetFloatPixelData(
    PF_InData* in_data,
    PF_EffectWorld* world,
    PF_PixelFloat** pixels
)
{
    if (pixels) {
        *pixels = nullptr;
    }

    if (!in_data || !world || !pixels) {
        return false;
    }

    SuiteLease lease(
        in_data->pica_basicP,
        kPFPixelDataSuite,
        kPFPixelDataSuiteVersion2
    );

    const PF_PixelDataSuite2* suite = lease.Get<PF_PixelDataSuite2>();

    if (!suite) {
        return false;
    }

    return (
        suite->get_pixel_data_float(world, nullptr, pixels) == PF_Err_NONE &&
        *pixels != nullptr
    );
}

void RegisterFloatPixelFormat(PF_InData* in_data)
{
    if (!in_data) {
        return;
    }

    SuiteLease lease(
        in_data->pica_basicP,
        kPFPixelFormatSuite,
        kPFPixelFormatSuiteVersion2
    );

    const PF_PixelFormatSuite2* suite = lease.Get<PF_PixelFormatSuite2>();

    if (suite) {
        /*
         * Keep the host's existing integer formats. Only append the ARGB
         * float format that this implementation actually understands.
         */
        suite->PF_AddSupportedPixelFormat(
            in_data->effect_ref,
            PF_PixelFormat_ARGB128
        );
    }
}

/*
 * World validation and analysis adapters.
 */

bool ValidateWorld(
    const PF_EffectWorld* world,
    std::size_t pixel_size
)
{
    if (
        !world ||
        world->width <= 0 ||
        world->height <= 0 ||
        world->rowbytes == 0
    ) {
        return false;
    }

    if (
        static_cast<std::uint64_t>(world->width) >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
        static_cast<std::uint64_t>(world->height) >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max())
    ) {
        return false;
    }

    const std::uint64_t width =
        static_cast<std::uint64_t>(world->width);

    const std::uint64_t row_size =
        width * static_cast<std::uint64_t>(pixel_size);

    const std::int64_t signed_stride =
        static_cast<std::int64_t>(world->rowbytes);

    const std::uint64_t stride = signed_stride < 0
        ? static_cast<std::uint64_t>(-signed_stride)
        : static_cast<std::uint64_t>(signed_stride);

    const std::uint64_t limit =
        static_cast<std::uint64_t>(
            std::numeric_limits<std::ptrdiff_t>::max()
        );

    if (stride < row_size || row_size > limit) {
        return false;
    }

    const std::uint64_t remaining_rows =
        static_cast<std::uint64_t>(world->height - 1);

    return remaining_rows == 0 ||
        stride <= (limit - row_size) / remaining_rows;
}

bool AnalysisBufferSize(
    A_long width,
    A_long height,
    std::size_t& channel_count,
    int& row_bytes
)
{
    if (width <= 0 || height <= 0) {
        return false;
    }

    const std::uint64_t row =
        static_cast<std::uint64_t>(width) * 4u * sizeof(float);

    if (row > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        return false;
    }

    const std::size_t w = static_cast<std::size_t>(width);
    const std::size_t h = static_cast<std::size_t>(height);
    const std::size_t maximum = std::numeric_limits<std::size_t>::max();

    if (w > maximum / h || w * h > maximum / 4u) {
        return false;
    }

    channel_count = w * h * 4u;

    if (channel_count > maximum / sizeof(float)) {
        return false;
    }

    row_bytes = static_cast<int>(row);
    return true;
}

template <typename Pixel>
Pixel LoadPixel(const unsigned char* row, A_long x)
{
    Pixel pixel;
    std::memcpy(
        &pixel,
        row + static_cast<std::size_t>(x) * sizeof(Pixel),
        sizeof(Pixel)
    );
    return pixel;
}

template <typename Pixel>
void ConvertWorldToAnalysis(
    const void* pixels,
    const PF_EffectWorld& world,
    double channel_maximum,
    std::vector<float>& rgba
)
{
    const auto* base = static_cast<const unsigned char*>(pixels);
    const std::ptrdiff_t stride =
        static_cast<std::ptrdiff_t>(world.rowbytes);
    const std::size_t width = static_cast<std::size_t>(world.width);

    for (A_long y = 0; y < world.height; ++y) {
        const unsigned char* row =
            base + static_cast<std::ptrdiff_t>(y) * stride;

        for (A_long x = 0; x < world.width; ++x) {
            const Pixel pixel = LoadPixel<Pixel>(row, x);

            double r = static_cast<double>(pixel.red) / channel_maximum;
            double g = static_cast<double>(pixel.green) / channel_maximum;
            double b = static_cast<double>(pixel.blue) / channel_maximum;
            double a = static_cast<double>(pixel.alpha) / channel_maximum;

            const std::size_t offset =
                (static_cast<std::size_t>(y) * width +
                 static_cast<std::size_t>(x)) * 4u;

            if (
                !std::isfinite(r) ||
                !std::isfinite(g) ||
                !std::isfinite(b) ||
                !std::isfinite(a) ||
                a <= kMinimumAlpha
            ) {
                rgba[offset] = 0.0f;
                rgba[offset + 1] = 0.0f;
                rgba[offset + 2] = 0.0f;
                rgba[offset + 3] = 0.0f;
                continue;
            }

            a = Clamp01(a);

            if (kPixelsArePremultiplied) {
                r /= a;
                g /= a;
                b /= a;
            }

            rgba[offset] = SafeFloat(r);
            rgba[offset + 1] = SafeFloat(g);
            rgba[offset + 2] = SafeFloat(b);
            rgba[offset + 3] = static_cast<float>(a);
        }
    }
}

bool AnalyzeAdobeLayer(
    PF_InData* in_data,
    PF_LayerDef* layer,
    FrameAnalysisResult& analysis
)
{
    if (!in_data || !layer) {
        return false;
    }

    std::size_t channel_count = 0;
    int analysis_row_bytes = 0;

    if (!AnalysisBufferSize(
            layer->width,
            layer->height,
            channel_count,
            analysis_row_bytes
        )) {
        return false;
    }

    PF_PixelFloat* float_pixels = nullptr;
    const bool is_float = GetFloatPixelData(in_data, layer, &float_pixels);

    const std::size_t pixel_size = is_float
        ? sizeof(PF_PixelFloat)
        : (PF_WORLD_IS_DEEP(layer) ? sizeof(PF_Pixel16) : sizeof(PF_Pixel8));

    if (
        !ValidateWorld(layer, pixel_size) ||
        (!is_float && !layer->data)
    ) {
        return false;
    }

    /*
     * A float analysis adapter preserves Adobe 16-bit precision and provides
     * one consistent place to handle channel order and alpha association.
     */
    std::vector<float> rgba(channel_count);

    if (is_float) {
        ConvertWorldToAnalysis<PF_PixelFloat>(
            float_pixels,
            *layer,
            1.0,
            rgba
        );
    } else if (PF_WORLD_IS_DEEP(layer)) {
        ConvertWorldToAnalysis<PF_Pixel16>(
            layer->data,
            *layer,
            static_cast<double>(PF_MAX_CHAN16),
            rgba
        );
    } else {
        ConvertWorldToAnalysis<PF_Pixel8>(
            layer->data,
            *layer,
            255.0,
            rgba
        );
    }

    ColorEngine engine;

    return engine.AnalyzeFrame32(
        rgba.data(),
        static_cast<int>(layer->width),
        static_cast<int>(layer->height),
        analysis_row_bytes,
        analysis
    );
}

bool CaptureTime(
    PF_InData* in_data,
    float seconds,
    A_long& target_time
)
{
    if (
        !in_data ||
        in_data->time_scale == 0 ||
        !std::isfinite(seconds) ||
        seconds < 0.0f
    ) {
        return false;
    }

    const double ticks =
        static_cast<double>(seconds) *
        static_cast<double>(in_data->time_scale);

    if (
        !std::isfinite(ticks) ||
        ticks < 0.0 ||
        ticks > static_cast<double>(std::numeric_limits<A_long>::max()) - 0.5
    ) {
        return false;
    }

    /*
     * Do not clamp to total_time. That can silently substitute an endpoint
     * or a different source frame. The host validates the checkout time.
     */
    target_time = static_cast<A_long>(std::floor(ticks + 0.5));
    return true;
}

bool AnalyzeLayerAtSeconds(
    PF_InData* in_data,
    float seconds,
    FrameAnalysisResult& analysis
)
{
    A_long target_time = 0;

    if (!CaptureTime(in_data, seconds, target_time)) {
        return false;
    }

    PF_ParamDef captured;
    AEFX_CLR_STRUCT(captured);

    PF_Err err = PF_CHECKOUT_PARAM(
        in_data,
        AUTOCUT_INPUT,
        target_time,
        in_data->time_step,
        in_data->time_scale,
        &captured
    );

    if (err != PF_Err_NONE) {
        return false;
    }

    bool succeeded = false;

    try {
        succeeded = AnalyzeAdobeLayer(in_data, &captured.u.ld, analysis);
    } catch (...) {
        PF_CHECKIN_PARAM(in_data, &captured);
        throw;
    }

    const PF_Err checkin_error = PF_CHECKIN_PARAM(in_data, &captured);
    return succeeded && checkin_error == PF_Err_NONE;
}

/*
 * Sequence capture cache.
 */

bool ReadCaptureState(
    PF_InData* in_data,
    CapturedAnalysisState& snapshot
)
{
    std::lock_guard<std::mutex> lock(gCaptureStateMutex);

    if (
        !in_data ||
        !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) <
            sizeof(CapturedAnalysisState)
    ) {
        return false;
    }

    const auto* state = reinterpret_cast<const CapturedAnalysisState*>(
        PF_LOCK_HANDLE(in_data->sequence_data)
    );

    if (!state) {
        return false;
    }

    std::memcpy(&snapshot, state, sizeof(snapshot));
    PF_UNLOCK_HANDLE(in_data->sequence_data);

    return snapshot.version == kCaptureStateVersion;
}

void InvalidateCaptureState(PF_InData* in_data)
{
    std::lock_guard<std::mutex> lock(gCaptureStateMutex);

    if (
        !in_data ||
        !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) <
            sizeof(CapturedAnalysisState)
    ) {
        return;
    }

    auto* state = reinterpret_cast<CapturedAnalysisState*>(
        PF_LOCK_HANDLE(in_data->sequence_data)
    );

    if (state) {
        const CapturedAnalysisState empty = DefaultCaptureState();
        std::memcpy(state, &empty, sizeof(empty));
        PF_UNLOCK_HANDLE(in_data->sequence_data);
    }
}

void StoreCapturedParams(
    PF_InData* in_data,
    float token,
    float seconds,
    const ColorCorrectionParams& params
)
{
    if (!ParamsAreFinite(params)) {
        return;
    }

    std::lock_guard<std::mutex> lock(gCaptureStateMutex);

    if (
        !in_data ||
        !in_data->sequence_data ||
        PF_GET_HANDLE_SIZE(in_data->sequence_data) <
            sizeof(CapturedAnalysisState)
    ) {
        return;
    }

    auto* state = reinterpret_cast<CapturedAnalysisState*>(
        PF_LOCK_HANDLE(in_data->sequence_data)
    );

    if (!state) {
        return;
    }

    CapturedAnalysisState replacement = DefaultCaptureState();
    replacement.valid = TRUE;
    replacement.capture_token = token;
    replacement.capture_seconds = seconds;
    replacement.params = params;

    std::memcpy(state, &replacement, sizeof(replacement));
    PF_UNLOCK_HANDLE(in_data->sequence_data);
}

bool ResolveAutoColorParams(
    PF_InData* in_data,
    PF_ParamDef* const params[],
    ColorCorrectionParams& result
)
{
    result = NeutralColorParams();

    float token = 0.0f;
    float seconds = 0.0f;

    if (
        !ReadFiniteParam(params, AUTOCUT_CAPTURE_TOKEN, token) ||
        !ReadFiniteParam(params, AUTOCUT_CAPTURE_SECONDS, seconds) ||
        token < 0.0f ||
        seconds < 0.0f
    ) {
        return false;
    }

    if (token > 0.5f) {
        CapturedAnalysisState snapshot{};

        if (
            ReadCaptureState(in_data, snapshot) &&
            snapshot.valid &&
            snapshot.capture_token == token &&
            snapshot.capture_seconds == seconds &&
            ParamsAreFinite(snapshot.params)
        ) {
            result = snapshot.params;
            return true;
        }

        FrameAnalysisResult analysis{};

        if (!AnalyzeLayerAtSeconds(in_data, seconds, analysis)) {
            // Never substitute the current render frame for the capture frame.
            return false;
        }

        result = ColorParamsFromAnalysis(analysis);
        StoreCapturedParams(in_data, token, seconds, result);
        return ParamsAreFinite(result);
    }

    FrameAnalysisResult analysis{};

    if (!AnalyzeAdobeLayer(in_data, &params[AUTOCUT_INPUT]->u.ld, analysis)) {
        /*
         * No capture was requested. Transparent/empty frames may render as
         * neutral rather than failing an otherwise valid frame render.
         */
        result = NeutralColorParams();
        return true;
    }

    result = ColorParamsFromAnalysis(analysis);
    return ParamsAreFinite(result);
}

ColorCorrectionParams ResolveFinalParams(
    PF_ParamDef* const params[],
    const ColorCorrectionParams& automatic,
    float auto_amount
)
{
    ColorCorrectionParams result = NeutralColorParams();

    /*
     * The analyzer already attenuates low-evidence recommendations.
     * Do not multiply them by a second arbitrary confidence floor here.
     */
    const double amount = Clamp01(auto_amount / 100.0);

    for (const ColorControl& control : ColorControls()) {
        const double base = FiniteOr(
            automatic.*(control.member),
            control.neutral
        );

        const double manual = Clamp(
            static_cast<double>(
                ParamValue(params, control.index, control.neutral)
            ),
            static_cast<double>(control.minimum),
            static_cast<double>(control.maximum)
        );

        const double combined =
            control.neutral +
            (base - control.neutral) * amount +
            (manual - control.neutral);

        result.*(control.member) = static_cast<float>(
            Clamp(
                combined,
                static_cast<double>(control.minimum),
                static_cast<double>(control.maximum)
            )
        );
    }

    result.confidence = static_cast<float>(Clamp01(automatic.confidence));
    return result;
}

/*
 * Per-render coefficients. Expensive uniform operations are computed once,
 * rather than once for every pixel.
 */

struct RenderKernel {
    double exposure_multiplier;
    double temperature;
    double tint;
    double contrast;
    double highlights;
    double shadows;
    double whites;
    double blacks;
    double saturation;
    double vibrance;
    double shadows_temp;
    double shadows_tint;
    double highlights_temp;
    double highlights_tint;
    bool neutral;
};

RenderKernel MakeKernel(const ColorCorrectionParams& p)
{
    RenderKernel kernel{};
    kernel.exposure_multiplier = std::exp2(static_cast<double>(p.exposure));
    kernel.temperature = p.temperature / 100.0;
    kernel.tint = p.tint / 100.0;
    kernel.contrast = p.contrast / 100.0;
    kernel.highlights = p.highlights / 100.0;
    kernel.shadows = p.shadows / 100.0;
    kernel.whites = p.whites / 100.0;
    kernel.blacks = p.blacks / 100.0;
    kernel.saturation = p.saturation / 100.0;
    kernel.vibrance = p.vibrance / 100.0;
    kernel.shadows_temp = p.shadows_temp / 100.0;
    kernel.shadows_tint = p.shadows_tint / 100.0;
    kernel.highlights_temp = p.highlights_temp / 100.0;
    kernel.highlights_tint = p.highlights_tint / 100.0;

    kernel.neutral =
        p.exposure == 0.0f &&
        p.temperature == 0.0f &&
        p.tint == 0.0f &&
        p.contrast == 0.0f &&
        p.highlights == 0.0f &&
        p.shadows == 0.0f &&
        p.whites == 0.0f &&
        p.blacks == 0.0f &&
        p.saturation == 100.0f &&
        p.vibrance == 0.0f &&
        p.shadows_temp == 0.0f &&
        p.shadows_tint == 0.0f &&
        p.highlights_temp == 0.0f &&
        p.highlights_tint == 0.0f;

    return kernel;
}

double WhiteBalanceProtect(double luma)
{
    const double value = Clamp01(luma);

    if (value > 0.82) {
        return 1.0 - 0.45 * Clamp01((value - 0.82) / 0.18);
    }

    if (value < 0.06) {
        return 0.70 + 0.30 * (value / 0.06);
    }

    return 1.0;
}

void AddLumaPreservingColor(
    double& r,
    double& g,
    double& b,
    double red_offset,
    double green_offset,
    double blue_offset
)
{
    const double luma_offset =
        Rec709Luma(red_offset, green_offset, blue_offset);

    r += red_offset - luma_offset;
    g += green_offset - luma_offset;
    b += blue_offset - luma_offset;
}

double HueDegrees(double r, double g, double b)
{
    const double maximum = std::max(r, std::max(g, b));
    const double minimum = std::min(r, std::min(g, b));
    const double delta = maximum - minimum;

    if (delta <= 1.0e-12) {
        return 0.0;
    }

    double hue;

    if (maximum == r) {
        hue = 60.0 * (g - b) / delta;
    } else if (maximum == g) {
        hue = 60.0 * ((b - r) / delta + 2.0);
    } else {
        hue = 60.0 * ((r - g) / delta + 4.0);
    }

    return hue < 0.0 ? hue + 360.0 : hue;
}

void ApplyColorCorrectionUnit(
    double& r,
    double& g,
    double& b,
    const RenderKernel& kernel,
    bool preserve_hdr
)
{
    if (kernel.neutral) {
        return;
    }

    r *= kernel.exposure_multiplier;
    g *= kernel.exposure_multiplier;
    b *= kernel.exposure_multiplier;

    const double protection = WhiteBalanceProtect(Rec709Luma(r, g, b));

    AddLumaPreservingColor(
        r,
        g,
        b,
        (kernel.temperature * 0.28 + kernel.tint * 0.12) * protection,
        -kernel.tint * 0.25 * protection,
        (-kernel.temperature * 0.28 + kernel.tint * 0.12) * protection
    );

    double luma = Rec709Luma(r, g, b);
    const double display_luma = Clamp01(luma);
    const double shadow_weight = 1.0 - display_luma;
    const double highlight_weight = display_luma;

    const double split_temperature =
        kernel.shadows_temp * shadow_weight +
        kernel.highlights_temp * highlight_weight;

    const double split_tint =
        kernel.shadows_tint * shadow_weight +
        kernel.highlights_tint * highlight_weight;

    AddLumaPreservingColor(
        r,
        g,
        b,
        split_temperature * 0.12 + split_tint * 0.06,
        -split_tint * 0.12,
        -split_temperature * 0.12 + split_tint * 0.06
    );

    luma = Rec709Luma(r, g, b);
    const double y = Clamp01(luma);
    double tone_delta = 0.0;

    if (kernel.contrast != 0.0) {
        tone_delta +=
            kernel.contrast * y * (1.0 - y) * (y - 0.5) * 3.8;
    }

    if (kernel.highlights != 0.0 && y > 0.40) {
        tone_delta +=
            kernel.highlights * 0.28 *
            std::pow((y - 0.40) / 0.60, 1.3);
    }

    if (kernel.shadows != 0.0 && y < 0.60) {
        tone_delta +=
            kernel.shadows * 0.28 *
            std::pow((0.60 - y) / 0.60, 1.3);
    }

    tone_delta += kernel.whites * 0.18 * y * y;
    tone_delta += kernel.blacks * 0.18 * (1.0 - y) * (1.0 - y);

    if (tone_delta != 0.0) {
        double target = luma + tone_delta;

        if (!preserve_hdr) {
            target = Clamp01(target);
        }

        if (luma > 1.0e-4 && target >= 0.0) {
            const double ratio = target / luma;
            r *= ratio;
            g *= ratio;
            b *= ratio;
        } else {
            // Avoid unstable division close to black or for negative float RGB.
            const double offset = target - luma;
            r += offset;
            g += offset;
            b += offset;
        }
    }

    luma = Rec709Luma(r, g, b);

    double vibrance_factor = 0.0;

    if (kernel.vibrance != 0.0) {
        const double maximum = std::max(r, std::max(g, b));
        const double minimum = std::min(r, std::min(g, b));
        const double saturation = maximum > 0.0
            ? Clamp01((maximum - minimum) / maximum)
            : 0.0;

        vibrance_factor = kernel.vibrance * (1.0 - saturation);

        const double hue = HueDegrees(r, g, b);

        // Warm-color protection is a heuristic, not skin recognition.
        if (hue >= 5.0 && hue <= 34.0) {
            vibrance_factor *= 0.35;
        }
    }

    const double chroma_multiplier =
        kernel.saturation * (1.0 + vibrance_factor);

    if (chroma_multiplier != 1.0) {
        r = luma + (r - luma) * chroma_multiplier;
        g = luma + (g - luma) * chroma_multiplier;
        b = luma + (b - luma) * chroma_multiplier;
    }

    /*
     * Avoid repeated intermediate clamps, which introduce hue shifts.
     * Integer output is clipped at the final boundary only.
     */
    if (!preserve_hdr) {
        r = Clamp01(r);
        g = Clamp01(g);
        b = Clamp01(b);
    }
}

template <typename Pixel>
struct PixelTraits;

template <>
struct PixelTraits<PF_Pixel8> {
    static double Maximum() { return 255.0; }
    static bool PreserveHDR() { return false; }

    static void Store(PF_Pixel8& pixel, double r, double g, double b)
    {
        pixel.red = static_cast<A_u_char>(Clamp01(r) * 255.0 + 0.5);
        pixel.green = static_cast<A_u_char>(Clamp01(g) * 255.0 + 0.5);
        pixel.blue = static_cast<A_u_char>(Clamp01(b) * 255.0 + 0.5);
    }
};

template <>
struct PixelTraits<PF_Pixel16> {
    static double Maximum() { return static_cast<double>(PF_MAX_CHAN16); }
    static bool PreserveHDR() { return false; }

    static void Store(PF_Pixel16& pixel, double r, double g, double b)
    {
        const double maximum = Maximum();

        pixel.red = static_cast<A_u_short>(Clamp01(r) * maximum + 0.5);
        pixel.green = static_cast<A_u_short>(Clamp01(g) * maximum + 0.5);
        pixel.blue = static_cast<A_u_short>(Clamp01(b) * maximum + 0.5);
    }
};

template <>
struct PixelTraits<PF_PixelFloat> {
    static double Maximum() { return 1.0; }
    static bool PreserveHDR() { return true; }

    static void Store(PF_PixelFloat& pixel, double r, double g, double b)
    {
        pixel.red = SafeFloat(r);
        pixel.green = SafeFloat(g);
        pixel.blue = SafeFloat(b);
    }
};

template <typename Pixel>
PF_Err ProcessPixel(
    void* refcon,
    Pixel* input,
    Pixel* output
)
{
    if (!refcon || !input || !output) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    const auto& kernel = *static_cast<const RenderKernel*>(refcon);

    // Preserve alpha and untouched pixels, including unusual float encodings.
    *output = *input;

    if (kernel.neutral) {
        return PF_Err_NONE;
    }

    const double maximum = PixelTraits<Pixel>::Maximum();
    double alpha = static_cast<double>(input->alpha) / maximum;

    if (!std::isfinite(alpha) || alpha <= kMinimumAlpha) {
        return PF_Err_NONE;
    }

    alpha = Clamp01(alpha);

    double r = static_cast<double>(input->red) / maximum;
    double g = static_cast<double>(input->green) / maximum;
    double b = static_cast<double>(input->blue) / maximum;

    if (!std::isfinite(r) || !std::isfinite(g) || !std::isfinite(b)) {
        // Preserve invalid source pixels rather than spreading NaNs in math.
        return PF_Err_NONE;
    }

    if (kPixelsArePremultiplied) {
        r /= alpha;
        g /= alpha;
        b /= alpha;
    }

    ApplyColorCorrectionUnit(
        r,
        g,
        b,
        kernel,
        PixelTraits<Pixel>::PreserveHDR()
    );

    if (kPixelsArePremultiplied) {
        r *= alpha;
        g *= alpha;
        b *= alpha;
    }

    if (!std::isfinite(r) || !std::isfinite(g) || !std::isfinite(b)) {
        return PF_Err_NONE;
    }

    PixelTraits<Pixel>::Store(*output, r, g, b);
    return PF_Err_NONE;
}

PF_Err ApplyColorCorrection8(
    void* refcon,
    A_long,
    A_long,
    PF_Pixel8* input,
    PF_Pixel8* output
)
{
    return ProcessPixel(refcon, input, output);
}

PF_Err ApplyColorCorrection16(
    void* refcon,
    A_long,
    A_long,
    PF_Pixel16* input,
    PF_Pixel16* output
)
{
    return ProcessPixel(refcon, input, output);
}

PF_Err ApplyColorCorrection32(
    void* refcon,
    A_long,
    A_long,
    PF_PixelFloat* input,
    PF_PixelFloat* output
)
{
    return ProcessPixel(refcon, input, output);
}

/*
 * Host callbacks.
 */

PF_Err About(PF_InData*, PF_OutData* out_data)
{
    if (!out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    std::snprintf(
        out_data->return_msg,
        sizeof(out_data->return_msg),
        "%s v%d.%d.%d\r%s",
        STR(StrID_Name),
        MAJOR_VERSION,
        MINOR_VERSION,
        BUG_VERSION,
        STR(StrID_Description)
    );

    return PF_Err_NONE;
}

PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data || !out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    out_data->my_version = PF_VERSION(
        MAJOR_VERSION,
        MINOR_VERSION,
        BUG_VERSION,
        STAGE_VERSION,
        BUILD_VERSION
    );

    out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE;

    out_data->out_flags2 =
        PF_OutFlag2_FLOAT_COLOR_AWARE |
        PF_OutFlag2_MUTABLE_RENDER_SEQUENCE_DATA_SLOWER;

    RegisterFloatPixelFormat(in_data);
    return PF_Err_NONE;
}

PF_Err AddFloatSlider(
    PF_InData* in_data,
    const char* name,
    float minimum,
    float maximum,
    float default_value,
    A_long disk_id,
    bool cannot_animate,
    bool supervised,
    bool invisible
)
{
    PF_ParamDef def;
    AEFX_CLR_STRUCT(def);

    def.param_type = PF_Param_FLOAT_SLIDER;
    PF_STRNNCPY(def.PF_DEF_NAME, name, sizeof(def.PF_DEF_NAME));

    def.u.fs_d.valid_min = static_cast<PF_FpShort>(minimum);
    def.u.fs_d.slider_min = static_cast<PF_FpShort>(minimum);
    def.u.fs_d.valid_max = static_cast<PF_FpShort>(maximum);
    def.u.fs_d.slider_max = static_cast<PF_FpShort>(maximum);
    def.u.fs_d.value = static_cast<PF_FpShort>(default_value);
    def.u.fs_d.dephault = static_cast<PF_FpShort>(default_value);
    def.u.fs_d.precision = PF_Precision_HUNDREDTHS;

    if (cannot_animate) {
        def.flags |= PF_ParamFlag_CANNOT_TIME_VARY;
    }

    if (supervised) {
        def.flags |= PF_ParamFlag_SUPERVISE;
    }

    if (invisible) {
        def.ui_flags |= PF_PUI_INVISIBLE;
    }

    def.uu.id = disk_id;
    return PF_ADD_PARAM(in_data, -1, &def);
}

PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data || !out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    A_long next_index = 1;

    for (const ColorControl& control : ColorControls()) {
        // Parameter order must match the enum in AutoCutColorEngine.h.
        if (control.index != next_index++) {
            return PF_Err_BAD_CALLBACK_PARAM;
        }

        const PF_Err error = AddFloatSlider(
            in_data,
            control.name,
            control.minimum,
            control.maximum,
            control.neutral,
            control.disk_id,
            false,
            true,
            false
        );

        if (error != PF_Err_NONE) {
            return error;
        }
    }

    PF_Err err = PF_Err_NONE;
    PF_ParamDef def;
    AEFX_CLR_STRUCT(def);

    PF_ADD_BUTTON(
        STR(StrID_AutoTrigger_Param_Name),
        "Refresh Auto Analysis",
        0,
        PF_ParamFlag_SUPERVISE | PF_ParamFlag_CANNOT_TIME_VARY,
        AUTO_TRIGGER_DISK_ID
    );

    if (err != PF_Err_NONE) {
        return err;
    }

    err = AddFloatSlider(
        in_data,
        STR(StrID_Confidence_Param_Name),
        0.0f,
        100.0f,
        100.0f,
        CONFIDENCE_DISK_ID,
        true,
        false,
        true
    );

    if (err != PF_Err_NONE) return err;

    err = AddFloatSlider(
        in_data,
        STR(StrID_CaptureToken_Param_Name),
        0.0f,
        1000000.0f,
        0.0f,
        CAPTURE_TOKEN_DISK_ID,
        true,
        true,
        false
    );

    if (err != PF_Err_NONE) return err;

    err = AddFloatSlider(
        in_data,
        STR(StrID_CaptureSeconds_Param_Name),
        0.0f,
        86400.0f,
        0.0f,
        CAPTURE_SECONDS_DISK_ID,
        true,
        true,
        false
    );

    if (err != PF_Err_NONE) return err;

    err = AddFloatSlider(
        in_data,
        STR(StrID_AutoAmount_Param_Name),
        0.0f,
        100.0f,
        80.0f,
        AUTO_AMOUNT_DISK_ID,
        false,
        true,
        false
    );

    if (err != PF_Err_NONE) return err;

    out_data->num_params = AUTOCUT_NUM_PARAMS;
    return PF_Err_NONE;
}

PF_Err SequenceSetup(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data || !out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    PF_Handle handle = PF_NEW_HANDLE(sizeof(CapturedAnalysisState));

    if (!handle) {
        return PF_Err_OUT_OF_MEMORY;
    }

    void* destination = PF_LOCK_HANDLE(handle);

    if (!destination) {
        PF_DISPOSE_HANDLE(handle);
        return PF_Err_OUT_OF_MEMORY;
    }

    const CapturedAnalysisState initial = DefaultCaptureState();
    std::memcpy(destination, &initial, sizeof(initial));
    PF_UNLOCK_HANDLE(handle);

    out_data->sequence_data = handle;
    return PF_Err_NONE;
}

PF_Err SequenceResetup(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data || !out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    if (
        in_data->sequence_data &&
        PF_GET_HANDLE_SIZE(in_data->sequence_data) >=
            sizeof(CapturedAnalysisState)
    ) {
        /*
         * Reuse storage but invalidate analysis on project reload/resetup.
         * Old render recommendations must not survive input/profile changes.
         */
        InvalidateCaptureState(in_data);
        out_data->sequence_data = in_data->sequence_data;
        return PF_Err_NONE;
    }

    const PF_Handle previous = in_data->sequence_data;
    const PF_Err error = SequenceSetup(in_data, out_data);

    if (error == PF_Err_NONE && previous) {
        PF_DISPOSE_HANDLE(previous);
    }

    return error;
}

PF_Err SequenceSetdown(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    std::lock_guard<std::mutex> lock(gCaptureStateMutex);

    if (in_data->sequence_data) {
        PF_DISPOSE_HANDLE(in_data->sequence_data);
        in_data->sequence_data = nullptr;
    }

    if (out_data) {
        out_data->sequence_data = nullptr;
    }

    return PF_Err_NONE;
}

PF_Err SequenceFlatten(PF_InData* in_data, PF_OutData* out_data)
{
    if (!in_data || !out_data) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    /*
     * The state is already flat: it contains no pointers or host handles.
     * Do not serialize mutexes, STL objects, or native pointers into it.
     */
    out_data->sequence_data = in_data->sequence_data;
    return PF_Err_NONE;
}

PF_Err Render(
    PF_InData* in_data,
    PF_OutData* out_data,
    PF_ParamDef* params[],
    PF_LayerDef* output
)
{
    if (
        !in_data ||
        !out_data ||
        !output ||
        !in_data->pica_basicP ||
        !ValidParameters(params)
    ) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    PF_LayerDef* input = &params[AUTOCUT_INPUT]->u.ld;

    if (output->width <= 0 || output->height <= 0) {
        return PF_Err_NONE;
    }

    PF_Err err = PF_COPY(input, output, nullptr, nullptr);

    if (err != PF_Err_NONE) {
        return err;
    }

    const float auto_amount = Clamp(
        ParamValue(params, AUTOCUT_AUTO_AMOUNT, 0.0f),
        0.0f,
        100.0f
    );

    ColorCorrectionParams automatic = NeutralColorParams();

    if (
        auto_amount > 0.0f &&
        !ResolveAutoColorParams(in_data, params, automatic)
    ) {
        std::snprintf(
            out_data->return_msg,
            sizeof(out_data->return_msg),
            "%s",
            "AutoCutStudio could not analyze the requested capture frame. "
            "Verify Capture Seconds and the effect-input time mapping."
        );

        return PF_Err_BAD_CALLBACK_PARAM;
    }

    const ColorCorrectionParams final_params =
        ResolveFinalParams(params, automatic, auto_amount);

    RenderKernel kernel = MakeKernel(final_params);

    if (kernel.neutral) {
        return PF_Err_NONE;
    }

    PF_PixelFloat* float_input = nullptr;
    PF_PixelFloat* float_output = nullptr;

    const bool input_is_float =
        GetFloatPixelData(in_data, input, &float_input);

    const bool output_is_float =
        GetFloatPixelData(in_data, output, &float_output);

    if (
        input_is_float != output_is_float ||
        (!output_is_float &&
         static_cast<bool>(PF_WORLD_IS_DEEP(input)) !=
         static_cast<bool>(PF_WORLD_IS_DEEP(output)))
    ) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    /*
     * Iterate suites receive the entire world (area == nullptr).
     * Progress length therefore uses output height, not an unrelated
     * extent_hint span.
     */
    const A_long lines = output->height;
    AEGP_SuiteHandler suites(in_data->pica_basicP);

    if (output_is_float) {
        return suites.IterateFloatSuite2()->iterate(
            in_data,
            0,
            lines,
            input,
            nullptr,
            &kernel,
            ApplyColorCorrection32,
            output
        );
    }

    if (PF_WORLD_IS_DEEP(output)) {
        return suites.Iterate16Suite2()->iterate(
            in_data,
            0,
            lines,
            input,
            nullptr,
            &kernel,
            ApplyColorCorrection16,
            output
        );
    }

    return suites.Iterate8Suite2()->iterate(
        in_data,
        0,
        lines,
        input,
        nullptr,
        &kernel,
        ApplyColorCorrection8,
        output
    );
}

PF_Err UserChangedParam(
    PF_InData* in_data,
    PF_OutData* out_data,
    void* extra
)
{
    if (!in_data || !out_data || !extra) {
        return PF_Err_BAD_CALLBACK_PARAM;
    }

    const auto* changed =
        static_cast<const PF_UserChangedParamExtra*>(extra);

    const int index = changed->param_index;

    if (
        index == AUTOCUT_AUTO_TRIGGER ||
        index == AUTOCUT_CAPTURE_TOKEN ||
        index == AUTOCUT_CAPTURE_SECONDS
    ) {
        InvalidateCaptureState(in_data);
    }

    if (
        index == AUTOCUT_AUTO_TRIGGER ||
        index == AUTOCUT_CAPTURE_TOKEN ||
        index == AUTOCUT_CAPTURE_SECONDS ||
        index == AUTOCUT_AUTO_AMOUNT ||
        (index >= AUTOCUT_TEMPERATURE && index <= AUTOCUT_HIGHLIGHTS_TINT)
    ) {
        out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
    }

    return PF_Err_NONE;
}

void SetFailureMessage(PF_OutData* out_data, const char* message)
{
    if (out_data) {
        std::snprintf(
            out_data->return_msg,
            sizeof(out_data->return_msg),
            "%s",
            message ? message : "AutoCutStudio encountered an internal error."
        );
    }
}

} // namespace

extern "C" DllExport
PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr,
    PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite*,
    const char*,
    const char*
)
{
    /*
     * Preserve this match name for existing projects.
     * Do not rename it merely to match the panel's display-name lookup.
     */
    PF_Err result = PF_Err_NONE;

    PF_REGISTER_EFFECT_EXT2(
        inPtr,
        inPluginDataCallBackPtr,
        "AutoCutStudio Color Engine",
        "ADBE AutoCutColorEngine",
        "AutoCut Studio",
        AE_RESERVED_INFO,
        "EffectMain",
        "https://github.com/Hamza-op/autocut-studio"
    );

    return result;
}

PF_Err EffectMain(
    PF_Cmd cmd,
    PF_InData* in_data,
    PF_OutData* out_data,
    PF_ParamDef* params[],
    PF_LayerDef* output,
    void* extra
)
{
    try {
        switch (cmd) {
            case PF_Cmd_ABOUT:
                return About(in_data, out_data);

            case PF_Cmd_GLOBAL_SETUP:
                return GlobalSetup(in_data, out_data);

            case PF_Cmd_PARAMS_SETUP:
                return ParamsSetup(in_data, out_data);

            case PF_Cmd_SEQUENCE_SETUP:
                return SequenceSetup(in_data, out_data);

            case PF_Cmd_SEQUENCE_RESETUP:
                return SequenceResetup(in_data, out_data);

            case PF_Cmd_SEQUENCE_FLATTEN:
                return SequenceFlatten(in_data, out_data);

            case PF_Cmd_SEQUENCE_SETDOWN:
                return SequenceSetdown(in_data, out_data);

            case PF_Cmd_RENDER:
                return Render(in_data, out_data, params, output);

            case PF_Cmd_USER_CHANGED_PARAM:
                return UserChangedParam(in_data, out_data, extra);

            default:
                return PF_Err_NONE;
        }
    } catch (const PF_Err& error) {
        return error;
    } catch (const std::bad_alloc&) {
        SetFailureMessage(
            out_data,
            "AutoCutStudio could not allocate the frame-analysis buffer."
        );
        return PF_Err_OUT_OF_MEMORY;
    } catch (const std::length_error&) {
        SetFailureMessage(
            out_data,
            "AutoCutStudio received a frame exceeding its buffer limits."
        );
        return PF_Err_OUT_OF_MEMORY;
    } catch (const std::exception& error) {
        SetFailureMessage(out_data, error.what());
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    } catch (...) {
        SetFailureMessage(
            out_data,
            "AutoCutStudio encountered an unexpected internal error."
        );
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
}