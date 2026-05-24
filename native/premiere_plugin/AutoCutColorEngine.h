#pragma once

#ifndef AUTOCUT_COLOR_ENGINE_H
#define AUTOCUT_COLOR_ENGINE_H

typedef unsigned char       u_char;
typedef unsigned short      u_short;
typedef unsigned short      u_int16;
typedef unsigned long       u_long;
typedef short int           int16;

#define PF_TABLE_BITS       12
#define PF_TABLE_SZ_16      4096
#define PF_DEEP_COLOR_AWARE 1   // 16bpc pixel awareness

#include "AEConfig.h"

#ifdef AE_OS_WIN
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif
    typedef unsigned short PixelType;
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
#include "AEFX_ChannelDepthTpl.h"
#include "AEGP_SuiteHandler.h"

#include "AutoCutColorEngine_Strings.h"

/* Versioning details */
#define MAJOR_VERSION   1
#define MINOR_VERSION   0
#define BUG_VERSION     0
#define PF_Stage_DEVELOP 0
#define STAGE_VERSION   PF_Stage_DEVELOP
#define BUILD_VERSION   1

/* Parameter enumerations */
enum {
    AUTOCUT_INPUT = 0,
    AUTOCUT_TEMPERATURE,
    AUTOCUT_TINT,
    AUTOCUT_EXPOSURE,
    AUTOCUT_CONTRAST,
    AUTOCUT_HIGHLIGHTS,
    AUTOCUT_SHADOWS,
    AUTOCUT_WHITES,
    AUTOCUT_BLACKS,
    AUTOCUT_SATURATION,
    AUTOCUT_VIBRANCE,
    AUTOCUT_SHADOWS_TEMP,
    AUTOCUT_SHADOWS_TINT,
    AUTOCUT_HIGHLIGHTS_TEMP,
    AUTOCUT_HIGHLIGHTS_TINT,
    AUTOCUT_AUTO_TRIGGER,
    AUTOCUT_CONFIDENCE,
    AUTOCUT_NUM_PARAMS
};

enum {
    TEMP_DISK_ID = 1,
    TINT_DISK_ID,
    EXPOSURE_DISK_ID,
    CONTRAST_DISK_ID,
    HIGHLIGHTS_DISK_ID,
    SHADOWS_DISK_ID,
    WHITES_DISK_ID,
    BLACKS_DISK_ID,
    SATURATION_DISK_ID,
    VIBRANCE_DISK_ID,
    SHADOWS_TEMP_DISK_ID,
    SHADOWS_TINT_DISK_ID,
    HIGHLIGHTS_TEMP_DISK_ID,
    HIGHLIGHTS_TINT_DISK_ID,
    AUTO_TRIGGER_DISK_ID,
    CONFIDENCE_DISK_ID
};

extern "C" {
    DllExport
    PF_Err
    EffectMain(
        PF_Cmd          cmd,
        PF_InData       *in_data,
        PF_OutData      *out_data,
        PF_ParamDef     *params[],
        PF_LayerDef     *output,
        void            *extra);
}

#endif // AUTOCUT_COLOR_ENGINE_H
