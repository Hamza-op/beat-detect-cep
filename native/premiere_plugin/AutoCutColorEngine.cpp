#include "AutoCutColorEngine.h"
#include "../color_engine/color_engine.h"
#include <cmath>
#include <algorithm>

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
};

static float Clamp01(float value)
{
    return std::max(0.0f, std::min(1.0f, value));
}

static float Rec709Luma(float r, float g, float b)
{
    return 0.299f * r + 0.587f * g + 0.114f * b;
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

// 8-bpc Pixel Processing Function
static PF_Err
ApplyColorCorrection8(
    void        *refcon, 
    A_long      xL, 
    A_long      yL, 
    PF_Pixel8   *inP, 
    PF_Pixel8   *outP)
{
    ColorCorrectionParams *params = reinterpret_cast<ColorCorrectionParams*>(refcon);
    
    // Normalize pixel channels to [0.0, 1.0]
    float r = inP->red / 255.0f;
    float g = inP->green / 255.0f;
    float b = inP->blue / 255.0f;
    float a = inP->alpha / 255.0f;

    // 1. Exposure (f-stops)
    float exp_factor = std::pow(2.0f, params->exposure);
    r *= exp_factor;
    g *= exp_factor;
    b *= exp_factor;

    // 2. White Balance (Temperature and Tint adjustments)
    // Temperature: cools (blue) or warms (amber/yellow)
    float wb_luma_before = Rec709Luma(r, g, b);
    float wb_protect = WhiteBalanceProtect(wb_luma_before);
    if (params->temperature != 0.0f) {
        float temp_adj = params->temperature / 100.0f;
        r += temp_adj * 0.28f * wb_protect;
        b -= temp_adj * 0.28f * wb_protect;
    }
    // Tint: greens or magentas
    if (params->tint != 0.0f) {
        float tint_adj = params->tint / 100.0f;
        g -= tint_adj * 0.25f * wb_protect;
        r += tint_adj * 0.12f * wb_protect;
        b += tint_adj * 0.12f * wb_protect;
    }
    float wb_luma_after = Rec709Luma(r, g, b);
    float wb_luma_delta = wb_luma_before - wb_luma_after;
    r += wb_luma_delta;
    g += wb_luma_delta;
    b += wb_luma_delta;

    // Clamp after color/exposure shifts
    r = Clamp01(r);
    g = Clamp01(g);
    b = Clamp01(b);

    float luma = Rec709Luma(r, g, b);

    // 3. Advanced Shadows/Highlights Tinting (3-Way Lift/Gain wheels)
    // Shadows Temp & Tint (Lift)
    if (params->shadows_temp != 0.0f || params->shadows_tint != 0.0f) {
        float shadows_temp_adj = params->shadows_temp / 100.0f;
        float shadows_tint_adj = params->shadows_tint / 100.0f;
        float factor = 1.0f - luma; // Apply more in dark areas
        
        r += shadows_temp_adj * 0.12f * factor;
        b -= shadows_temp_adj * 0.12f * factor;
        
        g -= shadows_tint_adj * 0.12f * factor;
        r += shadows_tint_adj * 0.06f * factor;
        b += shadows_tint_adj * 0.06f * factor;
    }

    // Highlights Temp & Tint (Gain)
    if (params->highlights_temp != 0.0f || params->highlights_tint != 0.0f) {
        float highlights_temp_adj = params->highlights_temp / 100.0f;
        float highlights_tint_adj = params->highlights_tint / 100.0f;
        float factor = luma; // Apply more in bright areas
        
        r += highlights_temp_adj * 0.12f * factor;
        b -= highlights_temp_adj * 0.12f * factor;
        
        g -= highlights_tint_adj * 0.12f * factor;
        r += highlights_tint_adj * 0.06f * factor;
        b += highlights_tint_adj * 0.06f * factor;
    }

    r = Clamp01(r);
    g = Clamp01(g);
    b = Clamp01(b);

    // 4. Contrast (Pivot around middle gray 0.5)
    if (params->contrast != 0.0f) {
        float c_factor = (100.0f + params->contrast) / 100.0f;
        c_factor = c_factor * c_factor; // quadratic response
        r = (r - 0.5f) * c_factor + 0.5f;
        g = (g - 0.5f) * c_factor + 0.5f;
        b = (b - 0.5f) * c_factor + 0.5f;
    }

    // 5. Highlights / Shadows (using soft curves)
    luma = Rec709Luma(r, g, b);
    
    if (params->highlights != 0.0f && luma > 0.5f) {
        float hi_factor = (luma - 0.5f) * 2.0f;
        float adj = (params->highlights / 100.0f) * 0.25f * hi_factor;
        r += adj; g += adj; b += adj;
    }
    
    if (params->shadows != 0.0f && luma < 0.5f) {
        float sh_factor = (0.5f - luma) * 2.0f;
        float adj = (params->shadows / 100.0f) * 0.25f * sh_factor;
        r += adj; g += adj; b += adj;
    }

    // 6. Whites / Blacks
    if (params->whites != 0.0f) {
        float wh_adj = (params->whites / 100.0f) * 0.15f * (luma * luma);
        r += wh_adj; g += wh_adj; b += wh_adj;
    }
    if (params->blacks != 0.0f) {
        float bl_adj = (params->blacks / 100.0f) * 0.15f * ((1.0f - luma) * (1.0f - luma));
        r += bl_adj; g += bl_adj; b += bl_adj;
    }

    r = std::max(0.0f, std::min(1.0f, r));
    g = std::max(0.0f, std::min(1.0f, g));
    b = std::max(0.0f, std::min(1.0f, b));
    luma = 0.299f * r + 0.587f * g + 0.114f * b;

    // 7. Advanced Secondary Grading: Vibrance (Skin-Safe non-linear saturation)
    if (params->vibrance != 0.0f) {
        float max_c = std::max({r, g, b});
        float min_c = std::min({r, g, b});
        float sat = (max_c > 0.0f) ? ((max_c - min_c) / max_c) : 0.0f;
        float vib_factor = (params->vibrance / 100.0f) * (1.0f - sat);
        
        // Skin tone protection using high-fidelity HSV check
        float df = max_c - min_c;
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
        
        // Scale down saturation boost for skin tones to protect faces without making bridal highlights waxy.
        if (h >= 5.0f && h <= 34.0f) {
            vib_factor *= 0.35f;
        }
        
        r += (r - luma) * vib_factor;
        g += (g - luma) * vib_factor;
        b += (b - luma) * vib_factor;
    }

    // 8. Advanced Secondary Grading: Luma vs. Saturation.
    // Preserve white clothing/decor glow; only near-clipped highlights get cleaned up,
    // and even those retain some chroma so they do not collapse into flat gray.
    luma = 0.299f * r + 0.587f * g + 0.114f * b;
    float desat_factor = 1.0f;
    if (luma < 0.08f) {
        desat_factor = 0.35f + 0.65f * (luma / 0.08f);
    } else if (luma > 0.995f) {
        desat_factor = 0.80f + 0.20f * ((1.0f - luma) / 0.005f);
    }
    desat_factor = std::max(0.0f, std::min(1.0f, desat_factor));
    if (desat_factor < 1.0f) {
        r = luma + (r - luma) * desat_factor;
        g = luma + (g - luma) * desat_factor;
        b = luma + (b - luma) * desat_factor;
    }

    // 9. Advanced Secondary Grading: Hue vs. Saturation (Organic green foliage & deep blue skies)
    float max_c = std::max({r, g, b});
    float min_c = std::min({r, g, b});
    float df = max_c - min_c;
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
        
        luma = 0.299f * r + 0.587f * g + 0.114f * b;

        if (h >= 65.0f && h <= 150.0f) {
            // Desaturate and organically shift neon yellow-greens toward deep forest greens
            g *= 0.95f; 
            r = luma + (r - luma) * 0.96f;
            g = luma + (g - luma) * 0.96f;
            b = luma + (b - luma) * 0.96f;
        } else if (h >= 180.0f && h <= 250.0f) {
            // Boost deep sky blues
            r = luma + (r - luma) * 1.06f;
            g = luma + (g - luma) * 1.06f;
            b = luma + (b - luma) * 1.06f;
        }
    }

    // 10. Global Saturation
    if (params->saturation != 100.0f) {
        float updated_luma = 0.299f * r + 0.587f * g + 0.114f * b;
        float sat_factor = params->saturation / 100.0f;
        r = updated_luma + (r - updated_luma) * sat_factor;
        g = updated_luma + (g - updated_luma) * sat_factor;
        b = updated_luma + (b - updated_luma) * sat_factor;
    }

    r = std::max(0.0f, std::min(1.0f, r));
    g = std::max(0.0f, std::min(1.0f, g));
    b = std::max(0.0f, std::min(1.0f, b));

    // Write final output channels
    outP->alpha = inP->alpha;
    outP->red   = static_cast<A_u_char>(std::max(0.0f, std::min(255.0f, r * 255.0f)));
    outP->green = static_cast<A_u_char>(std::max(0.0f, std::min(255.0f, g * 255.0f)));
    outP->blue  = static_cast<A_u_char>(std::max(0.0f, std::min(255.0f, b * 255.0f)));

    return PF_Err_NONE;
}

// 16-bpc Pixel Processing Function
static PF_Err
ApplyColorCorrection16(
    void        *refcon, 
    A_long      xL, 
    A_long      yL, 
    PF_Pixel16  *inP, 
    PF_Pixel16  *outP)
{
    ColorCorrectionParams *params = reinterpret_cast<ColorCorrectionParams*>(refcon);
    
    // Scale 16-bit to float [0.0, 1.0]
    float r = inP->red / 65535.0f;
    float g = inP->green / 65535.0f;
    float b = inP->blue / 65535.0f;

    // 1. Exposure (f-stops)
    float exp_factor = std::pow(2.0f, params->exposure);
    r *= exp_factor; g *= exp_factor; b *= exp_factor;

    // 2. White Balance (Temperature and Tint)
    float wb_luma_before = Rec709Luma(r, g, b);
    float wb_protect = WhiteBalanceProtect(wb_luma_before);
    if (params->temperature != 0.0f) {
        float temp_adj = params->temperature / 100.0f;
        r += temp_adj * 0.28f * wb_protect;
        b -= temp_adj * 0.28f * wb_protect;
    }
    if (params->tint != 0.0f) {
        float tint_adj = params->tint / 100.0f;
        g -= tint_adj * 0.25f * wb_protect;
        r += tint_adj * 0.12f * wb_protect;
        b += tint_adj * 0.12f * wb_protect;
    }
    float wb_luma_after = Rec709Luma(r, g, b);
    float wb_luma_delta = wb_luma_before - wb_luma_after;
    r += wb_luma_delta;
    g += wb_luma_delta;
    b += wb_luma_delta;

    r = Clamp01(r);
    g = Clamp01(g);
    b = Clamp01(b);

    float luma = Rec709Luma(r, g, b);

    // 3. Shadows/Highlights Tinting (Lift/Gain wheels)
    if (params->shadows_temp != 0.0f || params->shadows_tint != 0.0f) {
        float shadows_temp_adj = params->shadows_temp / 100.0f;
        float shadows_tint_adj = params->shadows_tint / 100.0f;
        float factor = 1.0f - luma;
        
        r += shadows_temp_adj * 0.12f * factor;
        b -= shadows_temp_adj * 0.12f * factor;
        
        g -= shadows_tint_adj * 0.12f * factor;
        r += shadows_tint_adj * 0.06f * factor;
        b += shadows_tint_adj * 0.06f * factor;
    }

    if (params->highlights_temp != 0.0f || params->highlights_tint != 0.0f) {
        float highlights_temp_adj = params->highlights_temp / 100.0f;
        float highlights_tint_adj = params->highlights_tint / 100.0f;
        float factor = luma;
        
        r += highlights_temp_adj * 0.12f * factor;
        b -= highlights_temp_adj * 0.12f * factor;
        
        g -= highlights_tint_adj * 0.12f * factor;
        r += highlights_tint_adj * 0.06f * factor;
        b += highlights_tint_adj * 0.06f * factor;
    }

    r = Clamp01(r);
    g = Clamp01(g);
    b = Clamp01(b);

    // 4. Contrast
    if (params->contrast != 0.0f) {
        float c_factor = (100.0f + params->contrast) / 100.0f;
        c_factor = c_factor * c_factor;
        r = (r - 0.5f) * c_factor + 0.5f;
        g = (g - 0.5f) * c_factor + 0.5f;
        b = (b - 0.5f) * c_factor + 0.5f;
    }

    // 5. Highlights / Shadows
    luma = Rec709Luma(r, g, b);
    
    if (params->highlights != 0.0f && luma > 0.5f) {
        float hi_factor = (luma - 0.5f) * 2.0f;
        float adj = (params->highlights / 100.0f) * 0.25f * hi_factor;
        r += adj; g += adj; b += adj;
    }
    if (params->shadows != 0.0f && luma < 0.5f) {
        float sh_factor = (0.5f - luma) * 2.0f;
        float adj = (params->shadows / 100.0f) * 0.25f * sh_factor;
        r += adj; g += adj; b += adj;
    }

    // 6. Whites / Blacks
    if (params->whites != 0.0f) {
        float wh_adj = (params->whites / 100.0f) * 0.15f * (luma * luma);
        r += wh_adj; g += wh_adj; b += wh_adj;
    }
    if (params->blacks != 0.0f) {
        float bl_adj = (params->blacks / 100.0f) * 0.15f * ((1.0f - luma) * (1.0f - luma));
        r += bl_adj; g += bl_adj; b += bl_adj;
    }

    r = std::max(0.0f, std::min(1.0f, r));
    g = std::max(0.0f, std::min(1.0f, g));
    b = std::max(0.0f, std::min(1.0f, b));
    luma = 0.299f * r + 0.587f * g + 0.114f * b;

    // 7. Advanced Secondary: Vibrance (Skin-Safe)
    if (params->vibrance != 0.0f) {
        float max_c = std::max({r, g, b});
        float min_c = std::min({r, g, b});
        float sat = (max_c > 0.0f) ? ((max_c - min_c) / max_c) : 0.0f;
        float vib_factor = (params->vibrance / 100.0f) * (1.0f - sat);
        
        float df = max_c - min_c;
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

    // 8. Advanced Secondary: Luma vs. Saturation
    luma = 0.299f * r + 0.587f * g + 0.114f * b;
    float desat_factor = 1.0f;
    if (luma < 0.08f) {
        desat_factor = 0.35f + 0.65f * (luma / 0.08f);
    } else if (luma > 0.995f) {
        desat_factor = 0.80f + 0.20f * ((1.0f - luma) / 0.005f);
    }
    desat_factor = std::max(0.0f, std::min(1.0f, desat_factor));
    if (desat_factor < 1.0f) {
        r = luma + (r - luma) * desat_factor;
        g = luma + (g - luma) * desat_factor;
        b = luma + (b - luma) * desat_factor;
    }

    // 9. Advanced Secondary: Hue vs. Saturation (Foliage & Sky)
    float max_c = std::max({r, g, b});
    float min_c = std::min({r, g, b});
    float df = max_c - min_c;
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
        
        luma = 0.299f * r + 0.587f * g + 0.114f * b;

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

    // 10. Global Saturation
    if (params->saturation != 100.0f) {
        float updated_luma = 0.299f * r + 0.587f * g + 0.114f * b;
        float sat_factor = params->saturation / 100.0f;
        r = updated_luma + (r - updated_luma) * sat_factor;
        g = updated_luma + (g - updated_luma) * sat_factor;
        b = updated_luma + (b - updated_luma) * sat_factor;
    }

    r = std::max(0.0f, std::min(1.0f, r));
    g = std::max(0.0f, std::min(1.0f, g));
    b = std::max(0.0f, std::min(1.0f, b));

    outP->alpha = inP->alpha;
    outP->red   = static_cast<A_u_short>(std::max(0.0f, std::min(65535.0f, r * 65535.0f)));
    outP->green = static_cast<A_u_short>(std::max(0.0f, std::min(65535.0f, g * 65535.0f)));
    outP->blue  = static_cast<A_u_short>(std::max(0.0f, std::min(65535.0f, b * 65535.0f)));

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
        "%s v%d.%d\r%s",
        STR(StrID_Name),
        MAJOR_VERSION,
        MINOR_VERSION,
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
    PF_ADD_BUTTON(STR(StrID_AutoTrigger_Param_Name), "Auto Calibrate", 0, 0, AUTO_TRIGGER_DISK_ID);

    // 16. Analysis Confidence Slider (read-only indicator)
    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX(STR(StrID_Confidence_Param_Name), 0, 100, 0, 100, 100,
                          PF_Precision_HUNDREDTHS, 0, 0, CONFIDENCE_DISK_ID);
    
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

    ColorCorrectionParams p;
    
    // Check if slider controls are at their default values
    bool all_defaults = (params[AUTOCUT_TEMPERATURE]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_TINT]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_EXPOSURE]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_CONTRAST]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_HIGHLIGHTS]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_SHADOWS]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_WHITES]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_BLACKS]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_SATURATION]->u.fs_d.value == 100.0f &&
                         params[AUTOCUT_VIBRANCE]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_SHADOWS_TEMP]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_SHADOWS_TINT]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_HIGHLIGHTS_TEMP]->u.fs_d.value == 0.0f &&
                         params[AUTOCUT_HIGHLIGHTS_TINT]->u.fs_d.value == 0.0f);

    // If defaults, perform dynamic auto color pixel-frame analysis!
    if (all_defaults) {
        FrameAnalysisResult analysis;
        ColorEngine engine;
        bool analyzed = false;

        PF_LayerDef* input_layer = &params[AUTOCUT_INPUT]->u.ld;
        if (input_layer && input_layer->data) {
            if (PF_WORLD_IS_DEEP(input_layer)) {
                analyzed = engine.AnalyzeFrame16(
                    reinterpret_cast<const unsigned short*>(input_layer->data),
                    input_layer->width,
                    input_layer->height,
                    input_layer->rowbytes,
                    analysis
                );
            } else {
                analyzed = engine.AnalyzeFrame8(
                    reinterpret_cast<const unsigned char*>(input_layer->data),
                    input_layer->width,
                    input_layer->height,
                    input_layer->rowbytes,
                    analysis
                );
            }
        }

        if (analyzed) {
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
        } else {
            // Fallback defaults
            p.temperature = 0.0f; p.tint = 0.0f; p.exposure = 0.0f; p.contrast = 0.0f;
            p.highlights = 0.0f; p.shadows = 0.0f; p.whites = 0.0f; p.blacks = 0.0f; p.saturation = 100.0f;
            p.vibrance = 0.0f; p.shadows_temp = 0.0f; p.shadows_tint = 0.0f; p.highlights_temp = 0.0f; p.highlights_tint = 0.0f;
        }
    } else {
        // Respect explicit manual slider overrides
        p.temperature     = static_cast<float>(params[AUTOCUT_TEMPERATURE]->u.fs_d.value);
        p.tint            = static_cast<float>(params[AUTOCUT_TINT]->u.fs_d.value);
        p.exposure        = static_cast<float>(params[AUTOCUT_EXPOSURE]->u.fs_d.value);
        p.contrast        = static_cast<float>(params[AUTOCUT_CONTRAST]->u.fs_d.value);
        p.highlights      = static_cast<float>(params[AUTOCUT_HIGHLIGHTS]->u.fs_d.value);
        p.shadows         = static_cast<float>(params[AUTOCUT_SHADOWS]->u.fs_d.value);
        p.whites          = static_cast<float>(params[AUTOCUT_WHITES]->u.fs_d.value);
        p.blacks          = static_cast<float>(params[AUTOCUT_BLACKS]->u.fs_d.value);
        p.saturation      = static_cast<float>(params[AUTOCUT_SATURATION]->u.fs_d.value);
        p.vibrance        = static_cast<float>(params[AUTOCUT_VIBRANCE]->u.fs_d.value);
        p.shadows_temp    = static_cast<float>(params[AUTOCUT_SHADOWS_TEMP]->u.fs_d.value);
        p.shadows_tint    = static_cast<float>(params[AUTOCUT_SHADOWS_TINT]->u.fs_d.value);
        p.highlights_temp = static_cast<float>(params[AUTOCUT_HIGHLIGHTS_TEMP]->u.fs_d.value);
        p.highlights_tint = static_cast<float>(params[AUTOCUT_HIGHLIGHTS_TINT]->u.fs_d.value);
    }

    A_long linesL = output->extent_hint.bottom - output->extent_hint.top;

    if (PF_WORLD_IS_DEEP(output)) {
        ERR(suites.Iterate16Suite2()->iterate(  in_data,
                                                0,
                                                linesL,
                                                &params[AUTOCUT_INPUT]->u.ld,
                                                NULL,
                                                (void*)&p,
                                                ApplyColorCorrection16,
                                                output));
    } else {
        ERR(suites.Iterate8Suite2()->iterate(   in_data,
                                                0,
                                                linesL,
                                                &params[AUTOCUT_INPUT]->u.ld,
                                                NULL,
                                                (void*)&p,
                                                ApplyColorCorrection8,
                                                output));  
    }

    return err;
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
                
            case PF_Cmd_RENDER:
                err = Render(in_data, out_data, params, output);
                break;
        }
    }
    catch (PF_Err &thrown_err) {
        err = thrown_err;
    }
    return err;
}
