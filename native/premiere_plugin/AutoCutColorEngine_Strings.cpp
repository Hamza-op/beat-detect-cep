#include "AutoCutColorEngine.h"

typedef struct {
    A_u_long    index;
    A_char      str[256];
} TableString;

TableString     g_strs[StrID_NUMTYPES] = {
    StrID_NONE,                     "",
    StrID_Name,                     "AutoCutStudio Color Engine",
    StrID_Description,              "AutoCut Studio frame-analyzing automatic color correction engine.\rCopyright 2026 AutoCut Studio.",
    StrID_Temp_Param_Name,          "Temperature",
    StrID_Tint_Param_Name,          "Tint",
    StrID_Exposure_Param_Name,      "Exposure",
    StrID_Contrast_Param_Name,      "Contrast",
    StrID_Highlights_Param_Name,    "Highlights",
    StrID_Shadows_Param_Name,       "Shadows",
    StrID_Whites_Param_Name,        "Whites",
    StrID_Blacks_Param_Name,        "Blacks",
    StrID_Saturation_Param_Name,    "Saturation",
    StrID_Vibrance_Param_Name,      "Vibrance",
    StrID_ShadowsTemp_Param_Name,   "Shadows Temp (Lift)",
    StrID_ShadowsTint_Param_Name,   "Shadows Tint (Lift)",
    StrID_HighlightsTemp_Param_Name,"Highlights Temp (Gain)",
    StrID_HighlightsTint_Param_Name,"Highlights Tint (Gain)",
    StrID_AutoTrigger_Param_Name,   "Auto Analysis",
    StrID_Confidence_Param_Name,    "Analysis Confidence",
    StrID_CaptureToken_Param_Name,  "Frame Capture Token",
    StrID_CaptureSeconds_Param_Name,"Frame Capture Seconds",
};

char    *GetStringPtr(int strNum)
{
    return g_strs[strNum].str;
}
