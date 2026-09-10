#ifndef AUTOCUT_COLOR_ENGINE_H
#define AUTOCUT_COLOR_ENGINE_H

/*
 * AutoCutStudio Color Engine Adobe SDK interface.
 *
 * Requires C++17 and the Adobe SDK headers used by the implementation.
 *
 * Compatibility rules:
 * - Preserve existing parameter indices and disk IDs.
 * - Append new parameters immediately before AUTOCUT_NUM_PARAMS.
 * - Assign new, unique disk IDs; never reuse a retired disk ID.
 * - Keep ParamsSetup registration order synchronized with these indices.
 * - Keep effect version metadata synchronized with the plugin resources.
 *
 * Generic integer aliases and channel-table macros are intentionally omitted.
 * Use Adobe SDK types for SDK interfaces and <cstdint> types for internal data.
 */

#ifndef __cplusplus
    #error "AutoCutColorEngine.h requires a C++ compiler."
#endif

/*
 * Define Windows configuration before any SDK header can include Windows.h.
 * Prevent Windows min/max macros from breaking std::min and std::max.
 */
#if defined(_WIN32)
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif

    #ifndef WIN32_LEAN_AND_MEAN
        #define WIN32_LEAN_AND_MEAN
    #endif
#endif

#include "AEConfig.h"

/*
 * Some SDK headers conditionally expose deep-color declarations using this
 * macro. It must be defined before including those headers.
 *
 * This declaration does not replace the runtime DEEP_COLOR_AWARE out flag.
 */
#ifndef PF_DEEP_COLOR_AWARE
    #define PF_DEEP_COLOR_AWARE 1
#elif PF_DEEP_COLOR_AWARE != 1
    #error "AutoCutStudio Color Engine requires deep-color SDK declarations."
#endif

#ifdef AE_OS_WIN
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif

    #ifndef WIN32_LEAN_AND_MEAN
        #define WIN32_LEAN_AND_MEAN
    #endif

    #include <Windows.h>
#endif

#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "AE_EffectCBSuites.h"
#include "String_Utils.h"
#include "AE_GeneralPlug.h"
#include "AEGP_SuiteHandler.h"

#include "AutoCutColorEngine_Strings.h"
#include "autocut_product_version.h"

/*
 * AEFX_ChannelDepthTpl.h is not needed by this implementation:
 * explicit PF_Pixel8/PF_Pixel16/PF_PixelFloat adapters handle channel depth.
 * Avoid including that template header solely for unused helper declarations.
 */

/*
 * Product version supplied by the generated/shared version header.
 */
#if !defined(AUTOCUT_PRODUCT_VERSION_MAJOR) || \
    !defined(AUTOCUT_PRODUCT_VERSION_MINOR) || \
    !defined(AUTOCUT_PRODUCT_VERSION_PATCH)
    #error "autocut_product_version.h must define major, minor, and patch versions."
#endif

/*
 * Allow build configuration to set release stage and build number.
 * Use the SDK's stage constants; do not redefine PF_Stage_DEVELOP.
 */
#ifndef AUTOCUT_COLOR_ENGINE_STAGE
    #define AUTOCUT_COLOR_ENGINE_STAGE PF_Stage_DEVELOP
#endif

#ifndef AUTOCUT_COLOR_ENGINE_BUILD
    #define AUTOCUT_COLOR_ENGINE_BUILD 0
#endif

/*
 * Legacy names retained for the existing implementation and resource code.
 * Define these only from the shared product version to avoid version drift.
 */
#define MAJOR_VERSION AUTOCUT_PRODUCT_VERSION_MAJOR
#define MINOR_VERSION AUTOCUT_PRODUCT_VERSION_MINOR
#define BUG_VERSION   AUTOCUT_PRODUCT_VERSION_PATCH
#define STAGE_VERSION AUTOCUT_COLOR_ENGINE_STAGE
#define BUILD_VERSION AUTOCUT_COLOR_ENGINE_BUILD

/*
 * Runtime parameter-array indices.
 *
 * Explicit values protect existing projects and panel integrations from
 * accidental renumbering when this list is edited.
 *
 * AUTOCUT_INPUT is the host-provided input layer, not a registered slider.
 */
enum AutoCutParameterIndex : int {
    AUTOCUT_INPUT           = 0,
    AUTOCUT_TEMPERATURE     = 1,
    AUTOCUT_TINT            = 2,
    AUTOCUT_EXPOSURE        = 3,
    AUTOCUT_CONTRAST        = 4,
    AUTOCUT_HIGHLIGHTS      = 5,
    AUTOCUT_SHADOWS         = 6,
    AUTOCUT_WHITES          = 7,
    AUTOCUT_BLACKS          = 8,
    AUTOCUT_SATURATION      = 9,
    AUTOCUT_VIBRANCE        = 10,
    AUTOCUT_SHADOWS_TEMP    = 11,
    AUTOCUT_SHADOWS_TINT    = 12,
    AUTOCUT_HIGHLIGHTS_TEMP = 13,
    AUTOCUT_HIGHLIGHTS_TINT = 14,
    AUTOCUT_AUTO_TRIGGER    = 15,
    AUTOCUT_CONFIDENCE      = 16,
    AUTOCUT_CAPTURE_TOKEN  = 17,
    AUTOCUT_CAPTURE_SECONDS = 18,
    AUTOCUT_AUTO_AMOUNT     = 19,

    AUTOCUT_NUM_PARAMS      = 20
};

/*
 * Persistent parameter disk IDs.
 *
 * Disk IDs are independent of parameter-array indices even though their
 * current values happen to match. Never derive one from the other.
 *
 * Keep historical IDs, including hidden or deprecated parameters, reserved.
 */
enum AutoCutParameterDiskId : int {
    TEMP_DISK_ID            = 1,
    TINT_DISK_ID            = 2,
    EXPOSURE_DISK_ID        = 3,
    CONTRAST_DISK_ID        = 4,
    HIGHLIGHTS_DISK_ID      = 5,
    SHADOWS_DISK_ID         = 6,
    WHITES_DISK_ID          = 7,
    BLACKS_DISK_ID          = 8,
    SATURATION_DISK_ID      = 9,
    VIBRANCE_DISK_ID        = 10,
    SHADOWS_TEMP_DISK_ID    = 11,
    SHADOWS_TINT_DISK_ID    = 12,
    HIGHLIGHTS_TEMP_DISK_ID = 13,
    HIGHLIGHTS_TINT_DISK_ID = 14,
    AUTO_TRIGGER_DISK_ID   = 15,
    CONFIDENCE_DISK_ID     = 16,
    CAPTURE_TOKEN_DISK_ID  = 17,
    CAPTURE_SECONDS_DISK_ID = 18,
    AUTO_AMOUNT_DISK_ID    = 19
};

/*
 * The current implementation uses a contiguous range for public color
 * controls. Make that dependency explicit.
 */
static_assert(
    AUTOCUT_TEMPERATURE == AUTOCUT_INPUT + 1,
    "The first public color control must follow the input layer."
);

static_assert(
    AUTOCUT_HIGHLIGHTS_TINT - AUTOCUT_TEMPERATURE == 13,
    "The implementation expects fourteen contiguous public color controls."
);

static_assert(
    AUTOCUT_AUTO_TRIGGER == AUTOCUT_HIGHLIGHTS_TINT + 1,
    "The Auto Trigger parameter must follow the public color controls."
);

static_assert(
    AUTOCUT_NUM_PARAMS == AUTOCUT_AUTO_AMOUNT + 1,
    "Update parameter registration and count when adding new parameters."
);

/*
 * Exported Adobe callbacks.
 *
 * Do not add noexcept or change calling conventions independently of the
 * implementation. Exceptions must be caught at the plugin entry boundary.
 */
extern "C" {

DllExport PF_Err EffectMain(
    PF_Cmd cmd,
    PF_InData* in_data,
    PF_OutData* out_data,
    PF_ParamDef* params[],
    PF_LayerDef* output,
    void* extra
);

DllExport PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr,
    PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite* inSPBasicSuitePtr,
    const char* inHostName,
    const char* inHostVersion
);

} // extern "C"

#endif // AUTOCUT_COLOR_ENGINE_H