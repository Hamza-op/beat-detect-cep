param(
    [string]$InputDir = "C:\Users\User\Pictures\test",
    [string]$OutputDir = "artifacts\color-grades",
    [switch]$AfterOnly
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$source = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public struct GradeParams {
    public float Temperature, Tint, Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Saturation, Vibrance;
    public float Confidence;
    public bool IsLog, IsLowLight;
    public float MeanY, StdDev, ShadowPct, HighlightPct, HighlightLuma;
}

public sealed class GradeReport {
    public string Name = "";
    public GradeParams Current;
    public GradeParams Calibrated;
    public string CurrentPath = "";
    public string CalibratedPath = "";
}

public static class AutoCutGradeHarness {
    private static float Clamp(float value, float min, float max) {
        return Math.Max(min, Math.Min(max, value));
    }

    private static float DeadZone(float value, float deadZone) {
        if (Math.Abs(value) <= deadZone) return 0.0f;
        return value > 0.0f ? value - deadZone : value + deadZone;
    }

    private static int ClampByte(float value) {
        return Math.Max(0, Math.Min(255, (int)(value * 255.0f)));
    }

    private static float Luma(float r, float g, float b) {
        return 0.299f * r + 0.587f * g + 0.114f * b;
    }

    private static float WhiteBalanceProtect(float luma) {
        if (luma > 0.82f) {
            float t = Clamp((luma - 0.82f) / 0.18f, 0.0f, 1.0f);
            return 1.0f - 0.45f * t;
        }
        if (luma < 0.06f) {
            return 0.70f + 0.30f * (luma / 0.06f);
        }
        return 1.0f;
    }

    private static float Hue(float r, float g, float b, float maxC, float minC) {
        float df = maxC - minC;
        if (df <= 0.0f) return 0.0f;
        float h;
        if (maxC == r) h = 60.0f * (((g - b) / df) % 6.0f);
        else if (maxC == g) h = 60.0f * (((b - r) / df) + 2.0f);
        else h = 60.0f * (((r - g) / df) + 4.0f);
        if (h < 0.0f) h += 360.0f;
        return h;
    }

    private static int Percentile(int[] histogram, int total, float percentile) {
        int cutoff = Math.Max(1, (int)(total * percentile));
        int accumulated = 0;
        for (int i = 0; i < histogram.Length; i++) {
            accumulated += histogram[i];
            if (accumulated >= cutoff) return i;
        }
        return histogram.Length - 1;
    }

    private static byte[] BitmapBytes(Bitmap bitmap, out BitmapData data) {
        Rectangle rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int size = Math.Abs(data.Stride) * data.Height;
        byte[] bytes = new byte[size];
        Marshal.Copy(data.Scan0, bytes, 0, size);
        return bytes;
    }

    public static GradeParams Analyze(Bitmap src, bool calibrated) {
        using (Bitmap bitmap = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(bitmap)) g.DrawImage(src, 0, 0, src.Width, src.Height);
            BitmapData data;
            byte[] bytes = BitmapBytes(bitmap, out data);
            try {
                long rSum = 0, gSum = 0, bSum = 0;
                long midR = 0, midG = 0, midB = 0, midCount = 0;
                long neutralR = 0, neutralG = 0, neutralB = 0, neutralCount = 0;
                long skinR = 0, skinG = 0, skinB = 0, skinCount = 0;
                int[] histogram = new int[256];
                int[] rHistogram = new int[256];
                int[] gHistogram = new int[256];
                int[] bHistogram = new int[256];
                int total = bitmap.Width * bitmap.Height;

                for (int y = 0; y < bitmap.Height; y++) {
                    int row = y * data.Stride;
                    for (int x = 0; x < bitmap.Width; x++) {
                        int i = row + x * 4;
                        int b = bytes[i + 0], g = bytes[i + 1], r = bytes[i + 2];
                        rSum += r; gSum += g; bSum += b;
                        int yv = Math.Max(0, Math.Min(255, (int)(0.299f * r + 0.587f * g + 0.114f * b)));
                        histogram[yv]++;
                        rHistogram[r]++;
                        gHistogram[g]++;
                        bHistogram[b]++;
                        if (yv > 40 && yv < 215) {
                            midR += r; midG += g; midB += b; midCount++;
                        }

                        float rf = r / 255.0f, gf = g / 255.0f, bf = b / 255.0f;
                        float maxC = Math.Max(rf, Math.Max(gf, bf));
                        float minC = Math.Min(rf, Math.Min(gf, bf));
                        float sat = maxC > 0.0f ? (maxC - minC) / maxC : 0.0f;
                        float hue = Hue(rf, gf, bf, maxC, minC);
                        if (hue >= 5.0f && hue <= 34.0f && sat >= 0.18f && sat <= 0.60f && maxC >= 0.25f && maxC <= 0.95f) {
                            skinR += r; skinG += g; skinB += b; skinCount++;
                        }
                        if (yv > 72 && yv < 238 && sat <= 0.14f && maxC >= 0.26f) {
                            neutralR += r; neutralG += g; neutralB += b; neutralCount++;
                        }
                    }
                }

                float meanR = (float)rSum / total;
                float meanG = (float)gSum / total;
                float meanB = (float)bSum / total;
                float meanY = 0.299f * meanR + 0.587f * meanG + 0.114f * meanB;

                int shadowLuma = Percentile(histogram, total, 0.01f);
                int lumaP10 = Percentile(histogram, total, 0.10f);
                int lumaMedian = Percentile(histogram, total, 0.50f);
                int lumaP90 = Percentile(histogram, total, 0.90f);
                int highlightLuma = Percentile(histogram, total, 0.99f);
                int rMedian = Percentile(rHistogram, total, 0.50f);
                int gMedian = Percentile(gHistogram, total, 0.50f);
                int bMedian = Percentile(bHistogram, total, 0.50f);

                float varSum = 0.0f;
                for (int i = 0; i < 256; i++) {
                    if (histogram[i] > 0) {
                        float d = i - meanY;
                        varSum += histogram[i] * d * d;
                    }
                }
                float stdDev = (float)Math.Sqrt(varSum / total);
                int shadowCrushed = 0;
                for (int i = 0; i < 15; i++) shadowCrushed += histogram[i];

                int highlightStart = calibrated ? 248 : 240;
                int highlightClipped = 0;
                for (int i = highlightStart; i < 256; i++) highlightClipped += histogram[i];

                float shadowPct = (float)shadowCrushed / total;
                float highlightPct = (float)highlightClipped / total;
                GradeParams p = new GradeParams();
                p.MeanY = meanY; p.StdDev = stdDev; p.ShadowPct = shadowPct; p.HighlightPct = highlightPct; p.HighlightLuma = highlightLuma;
                p.IsLowLight = meanY < 50.0f;
                p.IsLog = stdDev < 32.0f && shadowLuma > 25 && highlightLuma < 225;

                float targetGray = p.IsLowLight ? 92.0f : 118.0f;
                float tonePosition = calibrated ? lumaMedian : meanY;
                float toneDiff = targetGray - tonePosition;
                float exposureScale = calibrated && toneDiff < 0.0f ? 0.9f : (calibrated ? 3.0f : 2.5f);
                p.Exposure = Clamp((toneDiff / 255.0f) * exposureScale, calibrated ? -0.25f : -1.8f, calibrated ? 1.15f : 1.8f);

                if (p.IsLog) p.Contrast = calibrated ? 24.0f : 25.0f;
                else if (calibrated) {
                    int waveformSpread = lumaP90 - lumaP10;
                    if (waveformSpread > 145 || stdDev > 68.0f) p.Contrast = 0.0f;
                    else p.Contrast = Clamp((135.0f - waveformSpread) * 0.12f, 0.0f, 18.0f);
                }
                else if (stdDev > 65.0f) p.Contrast = 0.0f;
                else p.Contrast = Clamp((58.0f - stdDev) * 0.5f, 0.0f, 20.0f);

                if (calibrated ? (highlightPct > 0.08f || highlightLuma >= 253) : (highlightPct > 0.015f)) {
                    p.Highlights = calibrated ? -3.0f * (float)Math.Sqrt(highlightPct) : -15.0f * (float)Math.Sqrt(highlightPct);
                    p.Whites = calibrated ? 2.5f : 0.0f;
                } else {
                    p.Highlights = 0.0f;
                    p.Whites = calibrated ? (highlightLuma < 235 ? 3.0f : 2.0f) : 0.0f;
                }
                p.Highlights = Clamp(p.Highlights, calibrated ? -4.0f : -20.0f, 5.0f);
                p.Whites = Clamp(p.Whites, -5.0f, 5.0f);

                if (shadowPct > 0.02f) {
                    p.Shadows = (calibrated ? 12.0f : 15.0f) * (float)Math.Sqrt(shadowPct);
                    p.Blacks = 0.0f;
                } else {
                    p.Shadows = 0.0f;
                    p.Blacks = 0.0f;
                }
                p.Shadows = Clamp(p.Shadows, -5.0f, calibrated ? 18.0f : 25.0f);
                p.Blacks = Clamp(p.Blacks, -5.0f, 5.0f);

                p.Temperature = 0.0f; p.Tint = 0.0f;
                bool hasNeutral = calibrated && neutralCount > Math.Max(240, total / 420);
                long balanceCount = hasNeutral ? neutralCount : midCount;
                if (balanceCount > 100) {
                    float avgR = (float)(hasNeutral ? neutralR : midR) / balanceCount;
                    float avgG = (float)(hasNeutral ? neutralG : midG) / balanceCount;
                    float avgB = (float)(hasNeutral ? neutralB : midB) / balanceCount;
                    float neutralWeight = 0.0f;
                    if (hasNeutral) {
                        float neutralFraction = (float)neutralCount / total;
                        neutralWeight = Clamp((neutralFraction - 0.003f) / 0.045f, 0.35f, 0.82f);
                    }
                    float paradeRbDiff = rMedian - bMedian;
                    float rbDiff = calibrated ? ((avgR - avgB) * neutralWeight + paradeRbDiff * (1.0f - neutralWeight)) : (avgR - avgB);
                    rbDiff = calibrated ? DeadZone(rbDiff, 2.0f) : rbDiff;
                    float rbScale = calibrated ? (hasNeutral ? 0.42f : 0.28f) : 0.08f;
                    if (rbDiff > 0.0f) {
                        p.Temperature = -rbDiff * rbScale;
                        p.Temperature = Math.Max(calibrated ? (hasNeutral ? -9.0f : -5.0f) : -3.0f, p.Temperature);
                    } else {
                        p.Temperature = -rbDiff * (calibrated ? rbScale : 0.35f);
                        p.Temperature = Math.Min(calibrated ? (hasNeutral ? 12.0f : 7.0f) : 6.0f, p.Temperature);
                    }
                    float avgRb = (avgR + avgB) * 0.5f;
                    float paradeGDiff = gMedian - (rMedian + bMedian) * 0.5f;
                    float gDiff = calibrated ? ((avgG - avgRb) * neutralWeight + paradeGDiff * (1.0f - neutralWeight)) : (avgG - avgRb);
                    gDiff = calibrated ? DeadZone(gDiff, 1.5f) : gDiff;
                    float tintLimit = calibrated ? (hasNeutral ? 8.0f : 6.0f) : 5.0f;
                    float tintScale = calibrated ? (hasNeutral ? 0.42f : 0.32f) : 0.35f;
                    p.Tint = Clamp(gDiff * tintScale, -tintLimit, tintLimit);
                }

                if (skinCount > 200) {
                    float avgSkinR = (float)skinR / skinCount;
                    float avgSkinG = (float)skinG / skinCount;
                    float rgRatio = avgSkinR / (avgSkinG + 0.001f);
                    if (rgRatio > 1.45f) p.Temperature -= calibrated ? 0.7f : 0.5f;
                    else if (rgRatio < 1.15f) { p.Temperature += calibrated ? 1.0f : 1.0f; p.Tint += calibrated ? 0.5f : 0.5f; }
                }
                p.Temperature = Clamp(p.Temperature, calibrated ? -10.0f : -4.0f, calibrated ? 13.0f : 8.0f);
                p.Tint = Clamp(p.Tint, calibrated ? -8.0f : -6.0f, calibrated ? 8.0f : 6.0f);

                if (p.IsLog) p.Saturation = calibrated ? 116.0f : 118.0f;
                else if (p.IsLowLight) p.Saturation = calibrated ? 103.0f : 102.0f;
                else p.Saturation = calibrated ? 106.0f : 105.0f;
                p.Vibrance = p.IsLog ? (calibrated ? 14.0f : 15.0f) : (calibrated ? 10.0f : 8.0f);

                float confidence = 1.0f;
                if (p.IsLowLight) confidence -= 0.15f;
                if (highlightPct > 0.15f) confidence -= 0.20f;
                if (shadowPct > 0.15f) confidence -= 0.15f;
                p.Confidence = Clamp(confidence, 0.30f, 1.0f);
                return p;
            } finally {
                bitmap.UnlockBits(data);
            }
        }
    }

    public static Bitmap Render(Bitmap src, GradeParams p, bool calibrated) {
        Bitmap bitmap = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bitmap)) g.DrawImage(src, 0, 0, src.Width, src.Height);
        BitmapData data;
        byte[] bytes = BitmapBytes(bitmap, out data);
        try {
            for (int y = 0; y < bitmap.Height; y++) {
                int row = y * data.Stride;
                for (int x = 0; x < bitmap.Width; x++) {
                    int i = row + x * 4;
                    float b = bytes[i + 0] / 255.0f, g = bytes[i + 1] / 255.0f, r = bytes[i + 2] / 255.0f;
                    float expFactor = (float)Math.Pow(2.0, p.Exposure);
                    r *= expFactor; g *= expFactor; b *= expFactor;

                    float wbLumaBefore = Luma(r, g, b);
                    float wbProtect = WhiteBalanceProtect(wbLumaBefore);
                    if (p.Temperature != 0.0f) {
                        float t = p.Temperature / 100.0f;
                        float strength = calibrated ? 0.28f : 0.15f;
                        r += t * strength * wbProtect; b -= t * strength * wbProtect;
                    }
                    if (p.Tint != 0.0f) {
                        float t = p.Tint / 100.0f;
                        float greenStrength = calibrated ? 0.25f : 0.15f;
                        float rbStrength = calibrated ? 0.12f : 0.07f;
                        g -= t * greenStrength * wbProtect; r += t * rbStrength * wbProtect; b += t * rbStrength * wbProtect;
                    }
                    float wbLumaAfter = Luma(r, g, b);
                    float wbLumaDelta = wbLumaBefore - wbLumaAfter;
                    r += wbLumaDelta; g += wbLumaDelta; b += wbLumaDelta;
                    r = Clamp(r, 0.0f, 1.0f); g = Clamp(g, 0.0f, 1.0f); b = Clamp(b, 0.0f, 1.0f);

                    if (p.Contrast != 0.0f) {
                        float c = (100.0f + p.Contrast) / 100.0f;
                        c *= c;
                        r = (r - 0.5f) * c + 0.5f;
                        g = (g - 0.5f) * c + 0.5f;
                        b = (b - 0.5f) * c + 0.5f;
                    }

                    float l = Luma(r, g, b);
                    if (p.Highlights != 0.0f && l > 0.5f) {
                        float f = (l - 0.5f) * 2.0f;
                        float adj = (p.Highlights / 100.0f) * 0.25f * f;
                        r += adj; g += adj; b += adj;
                    }
                    if (p.Shadows != 0.0f && l < 0.5f) {
                        float f = (0.5f - l) * 2.0f;
                        float adj = (p.Shadows / 100.0f) * 0.25f * f;
                        r += adj; g += adj; b += adj;
                    }
                    if (p.Whites != 0.0f) {
                        float adj = (p.Whites / 100.0f) * 0.15f * (l * l);
                        r += adj; g += adj; b += adj;
                    }
                    if (p.Blacks != 0.0f) {
                        float adj = (p.Blacks / 100.0f) * 0.15f * ((1.0f - l) * (1.0f - l));
                        r += adj; g += adj; b += adj;
                    }

                    r = Clamp(r, 0.0f, 1.0f); g = Clamp(g, 0.0f, 1.0f); b = Clamp(b, 0.0f, 1.0f);
                    l = Luma(r, g, b);

                    if (p.Vibrance != 0.0f) {
                        float maxC = Math.Max(r, Math.Max(g, b));
                        float minC = Math.Min(r, Math.Min(g, b));
                        float sat = maxC > 0.0f ? (maxC - minC) / maxC : 0.0f;
                        float vib = (p.Vibrance / 100.0f) * (1.0f - sat);
                        float h = Hue(r, g, b, maxC, minC);
                        if (h >= 5.0f && h <= 34.0f) vib *= calibrated ? 0.35f : 0.20f;
                        r += (r - l) * vib; g += (g - l) * vib; b += (b - l) * vib;
                    }

                    l = Luma(r, g, b);
                    float desat = 1.0f;
                    if (calibrated) {
                        if (l < 0.08f) desat = 0.35f + 0.65f * (l / 0.08f);
                        else if (l > 0.995f) desat = 0.80f + 0.20f * ((1.0f - l) / 0.005f);
                    } else {
                        if (l < 0.12f) desat = l / 0.12f;
                        else if (l > 0.95f) desat = (1.0f - l) / 0.05f;
                    }
                    desat = Clamp(desat, 0.0f, 1.0f);
                    if (desat < 1.0f) {
                        r = l + (r - l) * desat;
                        g = l + (g - l) * desat;
                        b = l + (b - l) * desat;
                    }

                    float maxH = Math.Max(r, Math.Max(g, b));
                    float minH = Math.Min(r, Math.Min(g, b));
                    float hue2 = Hue(r, g, b, maxH, minH);
                    if (maxH - minH > 0.0f) {
                        l = Luma(r, g, b);
                        if (hue2 >= 65.0f && hue2 <= 150.0f) {
                            g *= 0.95f;
                            float f = calibrated ? 0.96f : 0.92f;
                            r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
                        } else if (hue2 >= 180.0f && hue2 <= 250.0f) {
                            float f = calibrated ? 1.06f : 1.10f;
                            r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
                        }
                    }

                    if (p.Saturation != 100.0f) {
                        l = Luma(r, g, b);
                        float sat = p.Saturation / 100.0f;
                        r = l + (r - l) * sat;
                        g = l + (g - l) * sat;
                        b = l + (b - l) * sat;
                    }

                    bytes[i + 0] = (byte)ClampByte(b);
                    bytes[i + 1] = (byte)ClampByte(g);
                    bytes[i + 2] = (byte)ClampByte(r);
                }
            }
            Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
        } finally {
            bitmap.UnlockBits(data);
        }
        return bitmap;
    }

    public static Bitmap MakeSheet(List<GradeReport> reports, string inputDir) {
        int thumbW = 420, thumbH = 236, labelH = 44;
        int width = thumbW * 3;
        int height = reports.Count * (thumbH + labelH);
        Bitmap sheet = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(sheet)) {
            g.Clear(Color.FromArgb(24, 24, 24));
            using (Font font = new Font("Segoe UI", 12.0f, FontStyle.Regular))
            using (Brush white = new SolidBrush(Color.White))
            using (Brush gray = new SolidBrush(Color.FromArgb(190, 190, 190))) {
                for (int i = 0; i < reports.Count; i++) {
                    GradeReport r = reports[i];
                    int y = i * (thumbH + labelH);
                    DrawThumb(g, Path.Combine(inputDir, r.Name), 0, y + labelH, thumbW, thumbH);
                    DrawThumb(g, r.CurrentPath, thumbW, y + labelH, thumbW, thumbH);
                    DrawThumb(g, r.CalibratedPath, thumbW * 2, y + labelH, thumbW, thumbH);
                    g.DrawString(r.Name, font, white, 6, y + 4);
                    g.DrawString("Original", font, gray, 6, y + 23);
                    g.DrawString(String.Format("Current  Hi {0:+0.00;-0.00;0.00}  Wh {1:+0.00;-0.00;0.00}  Sat {2:0.0}", r.Current.Highlights, r.Current.Whites, r.Current.Saturation), font, gray, thumbW + 6, y + 23);
                    g.DrawString(String.Format("Calibrated  Hi {0:+0.00;-0.00;0.00}  Wh {1:+0.00;-0.00;0.00}  Sat {2:0.0}", r.Calibrated.Highlights, r.Calibrated.Whites, r.Calibrated.Saturation), font, gray, thumbW * 2 + 6, y + 23);
                }
            }
        }
        return sheet;
    }

    private static void DrawThumb(Graphics g, string path, int x, int y, int w, int h) {
        using (Bitmap img = new Bitmap(path)) {
            float scale = Math.Min((float)w / img.Width, (float)h / img.Height);
            int dw = (int)(img.Width * scale);
            int dh = (int)(img.Height * scale);
            int dx = x + (w - dw) / 2;
            int dy = y + (h - dh) / 2;
            g.DrawImage(img, dx, dy, dw, dh);
        }
    }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing

$resolvedInput = Resolve-Path -LiteralPath $InputDir
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path (Get-Location) $OutputDir
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$images = Get-ChildItem -LiteralPath $resolvedInput -File |
    Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|bmp)$' -and $_.BaseName -notmatch '(_after|\.current|\.calibrated)$' } |
    Sort-Object Name

if (-not $images) {
    throw "No image files found in $resolvedInput"
}

$reports = New-Object 'System.Collections.Generic.List[GradeReport]'
$csv = New-Object 'System.Collections.Generic.List[string]'
$csv.Add("file,mode,mean_y,std_dev,highlight_luma,highlight_pct,shadow_pct,temperature,tint,exposure,contrast,highlights,shadows,whites,blacks,saturation,vibrance,confidence,is_log,is_low_light")

foreach ($image in $images) {
    $bitmap = [System.Drawing.Bitmap]::new($image.FullName)
    try {
        $current = [AutoCutGradeHarness]::Analyze($bitmap, $false)
        $calibrated = [AutoCutGradeHarness]::Analyze($bitmap, $true)
        $calibratedBitmap = [AutoCutGradeHarness]::Render($bitmap, $calibrated, $true)
        $base = [IO.Path]::GetFileNameWithoutExtension($image.Name)
        $currentPath = Join-Path $resolvedOutput "$base.current.png"
        $calibratedPath = if ($AfterOnly) { Join-Path $resolvedOutput "$base`_after.png" } else { Join-Path $resolvedOutput "$base.calibrated.png" }
        try {
            if (-not $AfterOnly) {
                $currentBitmap = [AutoCutGradeHarness]::Render($bitmap, $current, $false)
                try {
                    $currentBitmap.Save($currentPath, [System.Drawing.Imaging.ImageFormat]::Png)
                } finally {
                    $currentBitmap.Dispose()
                }
            }
            $calibratedBitmap.Save($calibratedPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $calibratedBitmap.Dispose()
        }

        $report = [GradeReport]::new()
        $report.Name = $image.Name
        $report.Current = $current
        $report.Calibrated = $calibrated
        $report.CurrentPath = $currentPath
        $report.CalibratedPath = $calibratedPath
        $reports.Add($report)

        foreach ($mode in @("current", "calibrated")) {
            $p = if ($mode -eq "current") { $current } else { $calibrated }
            $csv.Add(("{0},{1},{2:0.00},{3:0.00},{4:0.00},{5:0.0000},{6:0.0000},{7:0.00},{8:0.00},{9:0.00},{10:0.00},{11:0.00},{12:0.00},{13:0.00},{14:0.00},{15:0.00},{16:0.00},{17:0.00},{18},{19}" -f
                $image.Name,$mode,$p.MeanY,$p.StdDev,$p.HighlightLuma,$p.HighlightPct,$p.ShadowPct,$p.Temperature,$p.Tint,$p.Exposure,$p.Contrast,$p.Highlights,$p.Shadows,$p.Whites,$p.Blacks,$p.Saturation,$p.Vibrance,$p.Confidence,$p.IsLog,$p.IsLowLight))
        }
    } finally {
        $bitmap.Dispose()
    }
}

$csvPath = Join-Path $resolvedOutput "grade-results.csv"
$csv | Set-Content -LiteralPath $csvPath -Encoding UTF8

if (-not $AfterOnly) {
    $sheet = [AutoCutGradeHarness]::MakeSheet($reports, $resolvedInput)
    try {
        $sheetPath = Join-Path $resolvedOutput "comparison-sheet.png"
        $sheet.Save($sheetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $sheet.Dispose()
    }
}

Write-Host "Wrote $csvPath"
if (-not $AfterOnly) {
    Write-Host "Wrote $sheetPath"
} else {
    Write-Host "Wrote after images to $resolvedOutput"
}
