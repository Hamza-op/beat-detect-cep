import os
import sys
import subprocess

# Auto-install Pillow if missing
try:
    from PIL import Image
except ImportError:
    print("Pillow is required for image loading. Installing Pillow...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
    from PIL import Image

import math

def percentile_from_histogram(histogram, total_pixels, percentile):
    cutoff = max(1, int(total_pixels * percentile))
    accumulated = 0
    for i, count in enumerate(histogram):
        accumulated += count
        if accumulated >= cutoff:
            return i
    return 255

def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))

def dead_zone(value, threshold):
    if abs(value) <= threshold:
        return 0.0
    return value - threshold if value > 0 else value + threshold

def analyze_image(image_path):
    if not os.path.exists(image_path):
        print(f"Error: File '{image_path}' does not exist.")
        return

    try:
        img = Image.open(image_path).convert('RGB')
    except Exception as e:
        print(f"Error loading image: {e}")
        return

    width, height = img.size
    total_pixels = width * height

    print(f"Analyzing Image: {os.path.basename(image_path)}")
    print(f"Resolution: {width}x{height} ({total_pixels:,} pixels)")
    print("-" * 50)

    # Scans pixels and compute stats
    r_sum, g_sum, b_sum = 0, 0, 0
    mid_r_sum, mid_g_sum, mid_b_sum = 0, 0, 0
    mid_count = 0
    
    skin_r_sum, skin_g_sum, skin_b_sum = 0, 0, 0
    skin_count = 0
    neutral_r_sum, neutral_g_sum, neutral_b_sum = 0, 0, 0
    neutral_count = 0

    histogram = [0] * 256
    r_histogram = [0] * 256
    g_histogram = [0] * 256
    b_histogram = [0] * 256

    pixels = img.load()
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            
            r_sum += r
            g_sum += g
            b_sum += b

            # Rec.709 luma approximation
            luma = int(0.299 * r + 0.587 * g + 0.114 * b)
            luma = max(0, min(255, luma))
            histogram[luma] += 1
            r_histogram[r] += 1
            g_histogram[g] += 1
            b_histogram[b] += 1

            # Midtones gray balance (ignore extreme highlights/shadows)
            if 40 < luma < 215:
                mid_r_sum += r
                mid_g_sum += g
                mid_b_sum += b
                mid_count += 1

            # Robust HSV skin tone detector
            rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
            mx = max(rf, gf, bf)
            mn = min(rf, gf, bf)
            df = mx - mn
            
            h = 0.0
            if df > 0:
                if mx == rf:
                    h = 60.0 * (((gf - bf) / df) % 6.0)
                elif mx == gf:
                    h = 60.0 * (((bf - rf) / df) + 2.0)
                else:
                    h = 60.0 * (((rf - gf) / df) + 4.0)
                if h < 0:
                    h += 360.0
                    
            s = df / mx if mx > 0 else 0.0
            v = mx
            
            # Skin bounds: Hue [5, 34], Saturation [0.18, 0.60], Value [0.25, 0.95]
            if (5.0 <= h <= 34.0) and (0.18 <= s <= 0.60) and (0.25 <= v <= 0.95):
                skin_r_sum += r
                skin_g_sum += g
                skin_b_sum += b
                skin_count += 1

            if 72 < luma < 238 and s <= 0.14 and v >= 0.26:
                neutral_r_sum += r
                neutral_g_sum += g
                neutral_b_sum += b
                neutral_count += 1

    mean_r = r_sum / total_pixels
    mean_g = g_sum / total_pixels
    mean_b = b_sum / total_pixels
    mean_y = 0.299 * mean_r + 0.587 * mean_g + 0.114 * mean_b

    shadow_luma = percentile_from_histogram(histogram, total_pixels, 0.01)
    luma_p10 = percentile_from_histogram(histogram, total_pixels, 0.10)
    luma_median = percentile_from_histogram(histogram, total_pixels, 0.50)
    luma_p90 = percentile_from_histogram(histogram, total_pixels, 0.90)
    highlight_luma = percentile_from_histogram(histogram, total_pixels, 0.99)
    r_median = percentile_from_histogram(r_histogram, total_pixels, 0.50)
    g_median = percentile_from_histogram(g_histogram, total_pixels, 0.50)
    b_median = percentile_from_histogram(b_histogram, total_pixels, 0.50)

    # Standard deviation for contrast
    var_sum = 0
    for i in range(256):
        if histogram[i] > 0:
            diff = i - mean_y
            var_sum += histogram[i] * (diff * diff)
    
    std_dev = math.sqrt(var_sum / total_pixels)

    # Identify footage traits
    is_low_light = (mean_y < 50.0)
    is_log = (std_dev < 32.0 and shadow_luma > 25 and highlight_luma < 225)

    # 1. Waveform exposure: median placement, not average brightness.
    target_gray = 92.0 if is_low_light else 118.0
    diff_gray = target_gray - luma_median
    exposure_scale = 0.9 if diff_gray < 0.0 else 3.0
    exposure = (diff_gray / 255.0) * exposure_scale
    exposure = max(-0.25, min(1.15, exposure))

    # 2. Calibrated Contrast
    if is_log:
        contrast = 24.0
    else:
        waveform_spread = luma_p90 - luma_p10
        dev_ratio = 135.0 - waveform_spread
        if waveform_spread > 145 or std_dev > 68.0 or dev_ratio < 0:
            contrast = 0.0
        else:
            contrast = dev_ratio * 0.12
        contrast = max(0.0, min(18.0, contrast))

    # 3. Highlights & Shadows
    shadow_crushed_pixels = sum(histogram[0:15])
    highlight_clipped_pixels = sum(histogram[248:256])

    shadow_crush_pct = shadow_crushed_pixels / total_pixels
    highlight_clip_pct = highlight_clipped_pixels / total_pixels

    # Smart Highlights & Whites. Count only near-clipped pixels so bright white
    # clothing/decor does not get mistaken for blown exposure.
    if highlight_clip_pct > 0.08 or highlight_luma >= 253:
        highlights = -3.0 * math.sqrt(highlight_clip_pct)
        whites = 2.5
    else:
        highlights = 0.0
        whites = 3.0 if highlight_luma < 235 else 2.0
    highlights = max(-4.0, min(5.0, highlights))
    whites = max(-5.0, min(5.0, whites))

    # Smart Shadows & Blacks
    if shadow_crush_pct > 0.02:
        shadows = 12.0 * math.sqrt(shadow_crush_pct)
        blacks = 0.0
    else:
        shadows = 0.0
        blacks = 0.0
    shadows = max(-5.0, min(18.0, shadows))
    blacks = max(-5.0, min(5.0, blacks))

    # 4. White Balance (Temp and Tint)
    temperature = 0.0
    tint = 0.0
    
    has_neutral_reference = neutral_count > max(240, total_pixels // 420)
    balance_count = neutral_count if has_neutral_reference else mid_count
    if balance_count > 100:
        avg_balance_r = (neutral_r_sum if has_neutral_reference else mid_r_sum) / balance_count
        avg_balance_g = (neutral_g_sum if has_neutral_reference else mid_g_sum) / balance_count
        avg_balance_b = (neutral_b_sum if has_neutral_reference else mid_b_sum) / balance_count

        neutral_rb_diff = avg_balance_r - avg_balance_b
        parade_rb_diff = r_median - b_median
        neutral_fraction = neutral_count / total_pixels
        neutral_weight = clamp((neutral_fraction - 0.003) / 0.045, 0.35, 0.82) if has_neutral_reference else 0.0
        rb_diff = neutral_rb_diff * neutral_weight + parade_rb_diff * (1.0 - neutral_weight)
        rb_diff = dead_zone(rb_diff, 2.0)
        rb_scale = 0.42 if has_neutral_reference else 0.28
        rb_limit_cool = -9.0 if has_neutral_reference else -5.0
        rb_limit_warm = 12.0 if has_neutral_reference else 7.0

        if rb_diff > 0:
            temperature = max(rb_limit_cool, -rb_diff * rb_scale)
        else:
            temperature = min(rb_limit_warm, -rb_diff * rb_scale)

        avg_rb = (avg_balance_r + avg_balance_b) * 0.5
        neutral_g_diff = avg_balance_g - avg_rb
        parade_g_diff = g_median - (r_median + b_median) * 0.5
        g_diff = neutral_g_diff * neutral_weight + parade_g_diff * (1.0 - neutral_weight)
        g_diff = dead_zone(g_diff, 1.5)
        tint_scale = 0.42 if has_neutral_reference else 0.32
        tint_limit = 8.0 if has_neutral_reference else 6.0
        tint = g_diff * tint_scale
        tint = max(-tint_limit, min(tint_limit, tint))

    # 5. Skin tone priority
    skin_detected_str = "No"
    if skin_count > 200:
        skin_detected_str = f"Yes ({skin_count:,} pixels)"
        avg_skin_r = skin_r_sum / skin_count
        avg_skin_g = skin_g_sum / skin_count
        avg_skin_b = skin_b_sum / skin_count

        rg_ratio = avg_skin_r / (avg_skin_g + 0.001)
        if rg_ratio > 1.45:
            # Skin is too red/warm - gently adjust
            temperature -= 0.7
        elif rg_ratio < 1.15:
            # Skin is too pale/green - gently warm up
            temperature += 1.0
            tint += 0.5

    # Double check safety clamps for auto-WB
    temperature = max(-10.0, min(13.0, temperature))
    tint = max(-8.0, min(8.0, tint))

    # 6. Saturation
    if is_log:
        saturation = 116.0
    elif is_low_light:
        saturation = 103.0
    else:
        saturation = 106.0

    vibrance = 14.0 if is_log else 10.0

    # 7. Confidence
    confidence = 1.0
    if is_low_light:
        confidence -= 0.15
    if highlight_clip_pct > 0.15:
        confidence -= 0.20
    if shadow_crush_pct > 0.15:
        confidence -= 0.15
    confidence = max(0.30, min(1.0, confidence))

    # Print out detailed diagnostics!
    print("ANALYSIS READOUT:")
    print(f"  Average Luminance (Y): {mean_y:.2f} (Target: {target_gray})")
    print(f"  Standard Deviation   : {std_dev:.2f} (Contrast spread)")
    print(f"  Waveform Median      : {luma_median}")
    print(f"  RGB Parade Median    : R {r_median} / G {g_median} / B {b_median}")
    print(f"  Neutral Pixels       : {neutral_count:,}")
    print(f"  Shadow Percentile    : {shadow_luma} (1% dark point)")
    print(f"  Highlight Percentile : {highlight_luma} (99% bright point)")
    print(f"  Shadow Crushed %     : {shadow_crush_pct * 100:.2f}%")
    print(f"  Highlight Clipped %  : {highlight_clip_pct * 100:.2f}%")
    print(f"  Skin Tone Detected   : {skin_detected_str}")
    print(f"  Detected Log Curve   : {'Yes' if is_log else 'No'}")
    print(f"  Detected Low Light   : {'Yes' if is_low_light else 'No'}")
    print("-" * 50)
    print("PROPOSED AUTOCUTSTUDIO CORRECTION:")
    print(f"  Temperature : {temperature:+.2f}  (Warm/Cool correction)")
    print(f"  Tint        : {tint:+.2f}  (Green/Magenta correction)")
    print(f"  Exposure    : {exposure:+.2f}  (F-stops)")
    print(f"  Contrast    : {contrast:+.2f}")
    print(f"  Highlights  : {highlights:+.2f}")
    print(f"  Shadows     : {shadows:+.2f}")
    print(f"  Whites      : {whites:+.2f}")
    print(f"  Blacks      : {blacks:+.2f}")
    print(f"  Saturation  : {saturation:.2f}%")
    print(f"  Vibrance    : {vibrance:+.2f}")
    print(f"  Confidence  : {confidence * 100:.1f}%")
    print("-" * 50)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/test_color_engine.py <path_to_image>")
    else:
        analyze_image(sys.argv[1])
