#include "AEConfig.h"
#include "AE_EffectVers.h"

#ifndef AE_OS_WIN
    #include <AE_General.r>
#endif
    
resource 'PiPL' (16000) {
    {   /* array properties */
        /* [1] */
        Kind {
            AEEffect
        },
        /* [2] */
        Name {
            "AutoCutStudio Color Engine"
        },
        /* [3] */
        Category {
            "AutoCut Studio"
        },
#ifdef AE_OS_WIN
    #if defined(AE_PROC_INTELx64)
        CodeWin64X86 {"EffectMain"},
    #elif defined(AE_PROC_ARM64)
        CodeWinARM64 {"EffectMain"},
    #endif
#elif defined(AE_OS_MAC)
        CodeMacIntel64 {"EffectMain"},
        CodeMacARM64 {"EffectMain"},
#endif
        /* [6] */
        AE_PiPL_Version {
            2,
            0
        },
        /* [7] */
        AE_Effect_Spec_Version {
            PF_PLUG_IN_VERSION,
            PF_PLUG_IN_SUBVERS
        },
        /* [8] */
        AE_Effect_Version {
            524290  /* 1.0 build 2 */
        },
        /* [9] */
        AE_Effect_Info_Flags {
            0
        },
        /* [10] */
        AE_Effect_Global_OutFlags {
            0x02000000 // DEEP_COLOR_AWARE
        },
        AE_Effect_Global_OutFlags_2 {
            0x10001000 // FLOAT_COLOR_AWARE | MUTABLE_RENDER_SEQUENCE_DATA_SLOWER
        },
        /* [11] */
        AE_Effect_Match_Name {
            "ADBE AutoCutColorEngine"
        },
        /* [12] */
        AE_Reserved_Info {
            0
        },
        /* [13] */
        AE_Effect_Support_URL {
            "https://github.com/Hamza-op/autocut-studio"
        }
    }
};
