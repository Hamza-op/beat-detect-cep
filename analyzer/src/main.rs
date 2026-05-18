use std::env;
use std::error::Error;
use std::fs::File;
use std::path::Path;

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::conv::FromSample;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

#[derive(Debug, Serialize)]
struct Event {
    time: f64,
    score: f32,
}

#[derive(Clone, Copy)]
enum DetectionMode {
    Spikes,
    Music,
    Vocal,
}

#[derive(Clone, Copy)]
struct FrameEnergy {
    time: f64,
    bass: f32,
    body: f32,
    attack: f32,
    vocal: f32,
    wide: f32,
    flux: f32,
    rms: f32,
    peak: f32,
}

fn main() {
    std::panic::set_hook(Box::new(|panic_info| {
        eprintln!("internal analyzer error: {panic_info}");
    }));

    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let (mode, media_path) = parse_args()?;

    if !Path::new(&media_path).exists() {
        return Err(format!("media file does not exist: {media_path}").into());
    }

    let (samples, sample_rate) = decode_mono_audio(&media_path)?;
    if sample_rate == 0 {
        return Err("audio track has an invalid sample rate".into());
    }
    if samples.is_empty() {
        return Err("no decodable audio samples found".into());
    }

    let events = detect_events(&samples, sample_rate, mode);
    println!("{}", serde_json::to_string(&events)?);
    Ok(())
}

fn parse_args() -> Result<(DetectionMode, String), Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        return Err("usage: beat_analyzer [--mode spikes|music|vocal] <media-file-path>".into());
    }

    if args.len() >= 3 && args[0] == "--mode" {
        let mode = match args[1].as_str() {
            "spikes" => DetectionMode::Spikes,
            "music" => DetectionMode::Music,
            "vocal" => DetectionMode::Vocal,
            other => return Err(format!("unsupported detection mode: {other}").into()),
        };
        return Ok((mode, args[2..].join(" ")));
    }

    Ok((DetectionMode::Spikes, args.join(" ")))
}

fn decode_mono_audio(media_path: &str) -> Result<(Vec<f32>, u32), Box<dyn Error>> {
    let path = Path::new(media_path);
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let probed = get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| {
            track.codec_params.codec != CODEC_TYPE_NULL && track.codec_params.sample_rate.is_some()
        })
        .ok_or("no audio track found in media container")?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or("audio track has no sample rate")?;
    let mut decoder = get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut mono = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // Normal end-of-stream conditions — stop cleanly.
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                // Some formats signal a track reset mid-stream; just continue.
                continue;
            }
            Err(error) => return Err(Box::new(error)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => push_decoded_as_mono(decoded, &mut mono),
            // Malformed / corrupted packets — log to stderr, skip frame.
            Err(SymphoniaError::DecodeError(ref msg)) => {
                eprintln!("[beat_analyzer] skipping malformed packet: {msg}");
                continue;
            }
            Err(error) => return Err(Box::new(error)),
        }
    }

    Ok((mono, sample_rate))
}

fn push_decoded_as_mono(decoded: AudioBufferRef<'_>, mono: &mut Vec<f32>) {
    match decoded {
        AudioBufferRef::F32(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| buffer.chan(ch)[frame],
            mono,
        ),
        AudioBufferRef::U8(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::U16(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::U24(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::U32(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::S8(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::S16(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::S24(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::S32(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
        AudioBufferRef::F64(buffer) => push_planar_as_mono(
            buffer.spec().channels.count(),
            buffer.frames(),
            |ch, frame| f32::from_sample(buffer.chan(ch)[frame]),
            mono,
        ),
    }
}

#[inline(always)]
fn push_planar_as_mono<F>(channels: usize, frames: usize, mut read: F, mono: &mut Vec<f32>)
where
    F: FnMut(usize, usize) -> f32,
{
    if channels == 0 {
        return;
    }

    mono.reserve(frames);
    let gain = 1.0 / channels as f32;
    for frame in 0..frames {
        let mut sum = 0.0_f32;
        for ch in 0..channels {
            let s = read(ch, frame);
            // Sanitize: replace NaN/±inf with silence to avoid poisoning the pipeline.
            sum += if s.is_finite() { s } else { 0.0 };
        }
        let sample = sum * gain;
        // Final guard: clamp to [-1, 1] to handle badly-scaled decoders.
        mono.push(sample.clamp(-1.0, 1.0));
    }
}

fn detect_events(samples: &[f32], sample_rate: u32, mode: DetectionMode) -> Vec<Event> {
    // Validate inputs before touching the DSP pipeline.
    if sample_rate == 0 || samples.is_empty() {
        return Vec::new();
    }
    // Require at least one full analysis window of real samples.
    let min_samples = analysis_window_size(sample_rate);
    if samples.len() < min_samples {
        eprintln!(
            "[beat_analyzer] audio too short ({} samples, need {min_samples}), skipping",
            samples.len()
        );
        return Vec::new();
    }

    let frames = band_energies(samples, sample_rate);
    // Require at least 8 frames (≈ 1 s at 44.1 kHz/2048-hop) for stable statistics.
    if frames.len() < 8 {
        return Vec::new();
    }

    let spectral_scores = spectral_novelty_scores(&frames, mode);
    let envelope_scores = envelope_onset_scores(&frames, mode);
    let raw_scores = fuse_detector_scores(&spectral_scores, &envelope_scores, mode);
    let mut peak_candidates = pick_local_peaks(&frames, &raw_scores, mode);
    if peak_candidates.is_empty() {
        return Vec::new();
    }

    calibrate_peak_scores(&mut peak_candidates);

    let duplicate_gap = match mode {
        DetectionMode::Spikes => 0.150,
        DetectionMode::Music => 0.260,
        DetectionMode::Vocal => 0.850,
    };

    suppress_duplicates(peak_candidates, duplicate_gap)
        .into_iter()
        .filter(|(_, score)| *score >= 0.08)
        .map(|(time, score)| Event {
            time: round_to_millis(snap_event_time(samples, sample_rate, time, mode)),
            score: round_score(score),
        })
        .collect()
}

fn band_energies(samples: &[f32], sample_rate: u32) -> Vec<FrameEnergy> {
    if sample_rate == 0 {
        return Vec::new();
    }

    let sr = sample_rate as f32;
    let window_size = analysis_window_size(sample_rate);
    let hop = (window_size / 4).max(256);

    if samples.len() < window_size {
        return Vec::new();
    }

    let hann = (0..window_size)
        .map(|i| {
            let phase = (std::f32::consts::TAU * i as f32) / (window_size - 1) as f32;
            0.5 - 0.5 * phase.cos()
        })
        .collect::<Vec<_>>();

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(window_size);
    let mut buffer = vec![Complex::new(0.0, 0.0); window_size];
    let mut prev_mags = vec![0.0_f32; window_size / 2];
    let mut out = Vec::new();

    let mut start = 0;
    while start + window_size <= samples.len() {
        for i in 0..window_size {
            buffer[i].re = samples[start + i] * hann[i];
            buffer[i].im = 0.0;
        }

        let mut sum_squares = 0.0;
        let mut peak = 0.0_f32;
        for sample in &samples[start..start + window_size] {
            let abs = sample.abs();
            sum_squares += sample * sample;
            peak = peak.max(abs);
        }

        fft.process(&mut buffer);

        let mut bass = 0.0;
        let mut body = 0.0;
        let mut attack = 0.0;
        let mut vocal = 0.0;
        let mut wide = 0.0;
        let mut bass_bins = 0;
        let mut body_bins = 0;
        let mut attack_bins = 0;
        let mut vocal_bins = 0;
        let mut wide_bins = 0;
        let mut flux = 0.0;

        for (bin, value) in buffer.iter().take(window_size / 2).enumerate().skip(1) {
            let mag = value.norm();
            let diff = mag - prev_mags[bin];
            if diff > 0.0 {
                // High-frequency content (HFC) weighting for flux: multiply by a mild frequency factor
                let freq_weight = 1.0 + (bin as f32 / (window_size / 2) as f32);
                flux += diff * freq_weight;
            }
            prev_mags[bin] = mag;

            let freq = bin as f32 * sr / window_size as f32;
            let power = mag * mag;
            if (45.0..=180.0).contains(&freq) {
                bass += power;
                bass_bins += 1;
            }
            if (180.0..=950.0).contains(&freq) {
                body += power;
                body_bins += 1;
            }
            if (1_200.0..=8_000.0).contains(&freq) {
                attack += power;
                attack_bins += 1;
            }
            if (250.0..=4_000.0).contains(&freq) {
                vocal += power;
                vocal_bins += 1;
            }
            if (40.0..=10_000.0).contains(&freq) {
                wide += power;
                wide_bins += 1;
            }
        }

        out.push(FrameEnergy {
            time: (start + window_size / 2) as f64 / sample_rate as f64,
            bass: band_energy(bass, bass_bins),
            body: band_energy(body, body_bins),
            attack: band_energy(attack, attack_bins),
            vocal: band_energy(vocal, vocal_bins),
            wide: band_energy(wide, wide_bins),
            flux: energy_scale(flux / (window_size / 2) as f32),
            rms: energy_scale(sum_squares / window_size as f32),
            peak: energy_scale(peak),
        });

        start += hop;
    }

    out
}

fn analysis_window_size(sample_rate: u32) -> usize {
    let desired = (sample_rate as f32 * 0.046).round().max(1.0) as usize;
    nearest_power_of_two(desired).clamp(1024, 4096)
}

fn nearest_power_of_two(value: usize) -> usize {
    if value <= 1 {
        return 1;
    }

    let upper = value.next_power_of_two();
    let lower = upper / 2;
    if value - lower <= upper - value {
        lower
    } else {
        upper
    }
}

fn band_energy(power: f32, bins: usize) -> f32 {
    if bins == 0 {
        return 0.0;
    }
    energy_scale(power / bins as f32)
}

fn spectral_novelty_scores(frames: &[FrameEnergy], mode: DetectionMode) -> Vec<f32> {
    let mut scores = Vec::with_capacity(frames.len());
    let mut bass_base = frames[0].bass;
    let mut body_base = frames[0].body;
    let mut attack_base = frames[0].attack;
    let mut vocal_base = frames[0].vocal;
    let mut wide_base = frames[0].wide;
    let mut flux_base = frames[0].flux;

    for i in 0..frames.len() {
        let frame = frames[i];
        let previous = if i == 0 { frame } else { frames[i - 1] };
        let bass_rise = positive_rise(frame.bass, bass_base);
        let body_rise = positive_rise(frame.body, body_base);
        let attack_rise = positive_rise(frame.attack, attack_base);
        let vocal_rise = positive_rise(frame.vocal, vocal_base);
        let wide_rise = positive_rise(frame.wide, wide_base);
        let flux_rise = positive_rise(frame.flux, flux_base);
        
        let bass_snap = positive_rise(frame.bass, previous.bass);
        let body_snap = positive_rise(frame.body, previous.body);
        let attack_snap = positive_rise(frame.attack, previous.attack);
        let vocal_snap = positive_rise(frame.vocal, previous.vocal);
        let wide_snap = positive_rise(frame.wide, previous.wide);
        let flux_snap = positive_rise(frame.flux, previous.flux);

        // Spikes: bass/body heavy (kick/snare). Music: balanced attack+flux to catch
        // low-velocity hits and melodic entries without over-weighting noisy flux.
        let percussion = match mode {
            DetectionMode::Spikes => bass_rise * 0.52 + body_rise * 0.28 + attack_rise * 0.10 + wide_rise * 0.04 + flux_rise * 0.06,
            DetectionMode::Music => bass_rise * 0.30 + body_rise * 0.22 + attack_rise * 0.26 + wide_rise * 0.08 + flux_rise * 0.30,
            DetectionMode::Vocal => bass_rise * 0.16 + body_rise * 0.14 + attack_rise * 0.20 + wide_rise * 0.08 + flux_rise * 0.42,
        };
        let transient = match mode {
            DetectionMode::Spikes => bass_snap * 0.46 + body_snap * 0.24 + attack_snap * 0.18 + wide_snap * 0.04 + flux_snap * 0.08,
            DetectionMode::Music => bass_snap * 0.24 + body_snap * 0.18 + attack_snap * 0.30 + wide_snap * 0.10 + flux_snap * 0.36,
            DetectionMode::Vocal => bass_snap * 0.10 + body_snap * 0.10 + attack_snap * 0.24 + wide_snap * 0.10 + flux_snap * 0.46,
        };
        let section_jump = wide_rise * 0.32 + wide_snap * 0.16 + bass_rise * 0.10 + flux_rise * 0.25;
        let quiet_zone = if percussion + transient < 0.18 {
            1.0
        } else {
            0.38
        };
        let vocal_or_melodic =
            vocal_rise * (0.30 + 0.42 * quiet_zone) + vocal_snap * (0.14 + 0.18 * quiet_zone);
        let score = match mode {
            DetectionMode::Spikes => percussion * 0.80 + transient * 0.78 + section_jump * 0.32,
            DetectionMode::Music => {
                // Give percussion/transient equal standing with melodic to avoid
                // skipping rhythmic hits; reduce section_jump slightly to cut clutter.
                percussion * 0.44 + transient * 0.50 + vocal_or_melodic * 0.90 + section_jump * 0.60
            }
            DetectionMode::Vocal => {
                let phrase_entry =
                    vocal_rise * 0.92 + vocal_snap * 0.30 + wide_rise * 0.20 + body_rise * 0.10;
                let percussion_penalty =
                    (bass_snap * 0.34 + attack_snap * 0.42 + percussion * 0.18).min(0.62);
                (phrase_entry - percussion_penalty * 0.46).max(0.0)
            }
        };
        scores.push(score.max(0.0));

        // Use dual-rate EMA for baseline tracking: resists peaks (slow up), tracks noise floor (fast down, but not too fast to avoid ghost notes)
        bass_base = dual_rate_ema(bass_base, frame.bass, 0.015, 0.06);
        body_base = dual_rate_ema(body_base, frame.body, 0.015, 0.06);
        attack_base = dual_rate_ema(attack_base, frame.attack, 0.020, 0.08);
        vocal_base = dual_rate_ema(vocal_base, frame.vocal, 0.012, 0.05);
        wide_base = dual_rate_ema(wide_base, frame.wide, 0.010, 0.05);
        flux_base = dual_rate_ema(flux_base, frame.flux, 0.025, 0.10);
    }

    scores
}

fn envelope_onset_scores(frames: &[FrameEnergy], mode: DetectionMode) -> Vec<f32> {
    let mut scores = Vec::with_capacity(frames.len());
    let mut rms_base = frames[0].rms;
    let mut peak_base = frames[0].peak;

    for i in 0..frames.len() {
        let frame = frames[i];
        let previous = if i == 0 { frame } else { frames[i - 1] };
        let rms_rise = positive_rise(frame.rms, rms_base);
        let peak_rise = positive_rise(frame.peak, peak_base);
        let rms_snap = positive_rise(frame.rms, previous.rms);
        let peak_snap = positive_rise(frame.peak, previous.peak);
        let score = match mode {
            DetectionMode::Spikes => peak_rise * 0.58 + peak_snap * 0.42 + rms_rise * 0.22,
            // Music: balance peak sharpness with rms sustain to capture both
            // hard hits and soft low-velocity onsets.
            DetectionMode::Music => {
                peak_rise * 0.34 + peak_snap * 0.30 + rms_rise * 0.44 + rms_snap * 0.24
            }
            DetectionMode::Vocal => rms_rise * 0.72 + rms_snap * 0.18 + peak_rise * 0.06,
        };
        scores.push(score.max(0.0));

        rms_base = dual_rate_ema(rms_base, frame.rms, 0.015, 0.06);
        peak_base = dual_rate_ema(peak_base, frame.peak, 0.020, 0.08);
    }

    scores
}

fn fuse_detector_scores(spectral: &[f32], envelope: &[f32], mode: DetectionMode) -> Vec<f32> {
    let spectral_norm = normalize_series(spectral, 0.985);
    let envelope_norm = normalize_series(envelope, 0.985);
    let mut fused = Vec::with_capacity(spectral.len().min(envelope.len()));

    for i in 0..spectral_norm.len().min(envelope_norm.len()) {
        let spec = spectral_norm[i];
        let env = envelope_norm[i];
        let agreement = spec.min(env);
        let support = (spec * env).sqrt();
        let strong_single = spec.max(env);

        // Geometric mean of agreement and support captures true co-activation;
        // strong_single lets either detector carry a clear onset alone.
        let mut score = match mode {
            DetectionMode::Spikes => agreement * 0.72 + support * 0.30 + strong_single * 0.12,
            // Music: spec carries melodic novelty — give it a direct path even
            // when envelope agreement is moderate.
            DetectionMode::Music => agreement * 0.55 + support * 0.28 + spec * 0.22 + strong_single * 0.10,
            DetectionMode::Vocal => agreement * 0.56 + support * 0.18 + spec * 0.26,
        };

        // Penalty thresholds: relaxed so low-velocity soft beats (agreement ~0.12-0.20)
        // survive in Music mode rather than being zeroed out.
        match mode {
            DetectionMode::Spikes => {
                if agreement < 0.12 {
                    score *= if strong_single > 0.90 { 0.55 } else { 0.28 };
                } else if agreement < 0.28 {
                    score *= 0.72;
                }
            }
            DetectionMode::Music => {
                // Music mode: only penalise truly uncorroborated weak signals.
                if agreement < 0.08 {
                    score *= if strong_single > 0.80 { 0.70 } else { 0.42 };
                } else if agreement < 0.18 {
                    score *= 0.88;
                }
            }
            DetectionMode::Vocal => {
                if agreement < 0.08 {
                    score *= if strong_single > 0.80 { 0.68 } else { 0.40 };
                } else if agreement < 0.20 {
                    score *= 0.82;
                }
            }
        }

        fused.push(score.max(0.0));
    }

    fused
}

fn normalize_series(values: &[f32], percentile: f32) -> Vec<f32> {
    let normalizer = robust_percentile(values, percentile).max(0.000_001);
    values
        .iter()
        .map(|value| soft_compress(*value / normalizer))
        .collect()
}

fn soft_compress(value: f32) -> f32 {
    let x = value.max(0.0);
    if x <= 1.0 {
        x
    } else {
        1.0 + x.ln() * 0.4
    }
}

fn calibrate_peak_scores(peaks: &mut [(f64, f32)]) {
    if peaks.is_empty() {
        return;
    }

    let raw: Vec<f32> = peaks.iter().map(|(_, s)| *s).collect();
    let max_raw = raw.iter().copied().fold(0.0_f32, f32::max).max(0.000_001);
    // Use p10 floor so truly quiet peaks still register; p15 was discarding
    // too many soft-velocity events that sit in the 10-15% bucket.
    let p10 = robust_percentile(&raw, 0.10);
    let range = (max_raw - p10).max(0.000_001);

    for (_, score) in peaks.iter_mut() {
        let ratio = ((*score - p10) / range).clamp(0.0, 1.0);
        // Softer power curve (0.60) expands the lower score range so weak
        // beats get a usable score instead of clustering near 0.10.
        let shaped = ratio.powf(0.60);
        *score = (0.08 + shaped * 0.89).clamp(0.0, 0.97);
    }
}

fn pick_local_peaks(
    frames: &[FrameEnergy],
    scores: &[f32],
    mode: DetectionMode,
) -> Vec<(f64, f32)> {
    let nonzero: Vec<f32> = scores.iter().copied().filter(|v| *v > 0.0).collect();
    if nonzero.is_empty() {
        return Vec::new();
    }

    // Global silence gate: frames below the 5th percentile of wideband energy
    // are considered silence and always skipped.
    let mut wide_values: Vec<f32> = frames.iter().map(|f| f.wide).collect();
    wide_values.sort_by(|a, b| a.total_cmp(b));
    let wide_p05 = wide_values[(wide_values.len() as f32 * 0.05) as usize];
    let silence_floor = wide_p05.max(wide_values[wide_values.len() / 2] * 0.04);

    // Adaptive threshold: use a sliding window to compute a local median + k*MAD
    // so the detector adjusts to quieter passages instead of using a single global floor.
    let n = scores.len();
    // Half-window in frames: ~1.5 seconds of analysis frames (≈ 6 hop-widths at 44.1 kHz/2048)
    let half_win: usize = match mode {
        DetectionMode::Spikes => 20,
        DetectionMode::Music => 24,
        DetectionMode::Vocal => 30,
    };
    // Sensitivity multiplier above local median.
    // Spikes: 1.10 (tighter than before) — fewer false positives on noise bursts.
    // Music:  1.00 — balanced, catches soft hits.
    // Vocal:  1.45 — wide gate; vocal onsets are sparser and quieter.
    let k_mad: f32 = match mode {
        DetectionMode::Spikes => 1.10,
        DetectionMode::Music  => 1.00,
        DetectionMode::Vocal  => 1.45,
    };
    // Hard global floor so we never pick meaningless noise peaks
    let global_floor: f32 = match mode {
        DetectionMode::Spikes => 0.020,
        DetectionMode::Music => 0.016,
        DetectionMode::Vocal => 0.025,
    };

    // Pre-compute adaptive thresholds per frame
    let thresholds: Vec<f32> = (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half_win);
            let hi = (i + half_win).min(n - 1);
            let mut window: Vec<f32> = scores[lo..=hi]
                .iter()
                .copied()
                .filter(|v| *v > 0.0)
                .collect();
            if window.is_empty() {
                return global_floor;
            }
            window.sort_by(|a, b| a.total_cmp(b));
            let median = window[window.len() / 2];
            let mad: f32 = {
                let mut devs: Vec<f32> = window.iter().map(|v| (v - median).abs()).collect();
                devs.sort_by(|a, b| a.total_cmp(b));
                devs[devs.len() / 2]
            };
            (median + k_mad * mad).max(global_floor)
        })
        .collect();

    let mut peaks = Vec::new();

    for i in 1..n - 1 {
        if frames[i].wide < silence_floor {
            continue;
        }
        if scores[i] < thresholds[i] {
            continue;
        }
        // Local maximum condition: strict greater-than on right to avoid plateau duplicates
        if scores[i] >= scores[i - 1] && scores[i] > scores[i + 1] {
            let time = refine_peak_time(frames, scores, i);
            peaks.push((time, scores[i]));
        }
    }

    peaks
}

fn suppress_duplicates(mut peaks: Vec<(f64, f32)>, min_gap_seconds: f64) -> Vec<(f64, f32)> {
    peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut kept: Vec<(f64, f32)> = Vec::new();

    'outer: for candidate in peaks {
        for existing in &kept {
            if (candidate.0 - existing.0).abs() < min_gap_seconds {
                continue 'outer;
            }
        }
        kept.push(candidate);
    }

    kept.sort_by(|a, b| a.0.total_cmp(&b.0));
    kept
}

fn refine_peak_time(frames: &[FrameEnergy], scores: &[f32], index: usize) -> f64 {
    if index == 0 || index + 1 >= frames.len() || index + 1 >= scores.len() {
        return frames[index].time;
    }

    let left = scores[index - 1] as f64;
    let center = scores[index] as f64;
    let right = scores[index + 1] as f64;
    let denominator = left - 2.0 * center + right;

    if denominator.abs() < 1.0e-9 {
        return frames[index].time;
    }

    let offset_frames = (0.5 * (left - right) / denominator).clamp(-0.5, 0.5);
    let frame_step = ((frames[index + 1].time - frames[index - 1].time) * 0.5).max(0.0);
    frames[index].time + offset_frames * frame_step
}

fn snap_event_time(
    samples: &[f32],
    sample_rate: u32,
    estimated_time: f64,
    mode: DetectionMode,
) -> f64 {
    if samples.is_empty() || sample_rate == 0 {
        return estimated_time.max(0.0);
    }

    let sr = sample_rate as f64;
    let estimated = (estimated_time * sr).round() as isize;
    let look_back = match mode {
        DetectionMode::Spikes => 0.050,
        DetectionMode::Music => 0.055,
        DetectionMode::Vocal => 0.090,
    };
    let look_forward = match mode {
        DetectionMode::Spikes => 0.080,
        DetectionMode::Music => 0.090,
        DetectionMode::Vocal => 0.150,
    };
    let start = (estimated - (look_back * sr) as isize).max(1) as usize;
    let end = (estimated + (look_forward * sr) as isize)
        .max(start as isize + 1)
        .min(samples.len().saturating_sub(1) as isize) as usize;

    if start >= end {
        return estimated_time.max(0.0);
    }

    let local_mean = local_abs_mean(samples, start, end);
    let mut best_index = start;
    let mut best_score = 0.0_f32;
    for i in start..=end {
        let diff = (samples[i] - samples[i - 1]).abs();
        let amp = samples[i].abs();
        let score = diff * 0.72 + amp * 0.28;
        if score > best_score {
            best_score = score;
            best_index = i;
        }
    }

    if best_score <= local_mean.max(1.0e-6) * 1.8 {
        return estimated_time.max(0.0);
    }

    let pre_roll = match mode {
        DetectionMode::Spikes => 0.006,
        DetectionMode::Music => 0.008,
        DetectionMode::Vocal => 0.018,
    };
    ((best_index as f64 / sr) - pre_roll).max(0.0)
}

fn local_abs_mean(samples: &[f32], start: usize, end: usize) -> f32 {
    if start >= end || samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut count = 0;
    for sample in &samples[start..=end.min(samples.len() - 1)] {
        sum += sample.abs();
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

#[inline(always)]
fn energy_scale(value: f32) -> f32 {
    (value + 1.0e-12).ln_1p()
}

#[inline(always)]
fn positive_rise(current: f32, baseline: f32) -> f32 {
    let diff = current - baseline;
    if diff <= 0.0 {
        return 0.0;
    }
    // Adaptive denominator floor: 3 % of the current frame's energy prevents
    // division-by-near-zero on silent frames while keeping sensitivity for
    // low-velocity onsets. Cap the ratio at 12.0 to stop a single loud
    // transient from dominating the score scale.
    let adaptive_floor = (current * 0.03).max(0.004);
    (diff / baseline.max(adaptive_floor)).min(12.0)
}

#[inline(always)]
fn dual_rate_ema(previous: f32, current: f32, alpha_up: f32, alpha_down: f32) -> f32 {
    if current > previous {
        previous + (current - previous) * alpha_up
    } else {
        previous + (current - previous) * alpha_down
    }
}

fn robust_percentile(values: &[f32], percentile: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if sorted.is_empty() {
        return 0.0;
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let index = ((sorted.len() - 1) as f32 * percentile.clamp(0.0, 1.0)).round() as usize;
    sorted[index]
}

fn round_to_millis(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn round_score(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_nearest_analysis_window_at_common_video_rates() {
        assert_eq!(analysis_window_size(44_100), 2048);
        assert_eq!(analysis_window_size(48_000), 2048);
    }

    #[test]
    fn detects_dense_dhol_like_hits() {
        let sample_rate = 48_000;
        let expected = [0.50, 1.00, 1.50, 2.00, 2.50];
        let mut samples = synthetic_ambient(sample_rate, 3.5);
        add_dhol_hits(&mut samples, sample_rate, &expected);
        let events = detect_events(&samples, sample_rate, DetectionMode::Spikes);
        assert!(
            events.len() >= 3,
            "expected at least 3 events from 5 hits, got {:?}",
            events
        );

        let mut matched = 0;
        for target in expected {
            if events
                .iter()
                .any(|event| (event.time - target).abs() <= 0.065)
            {
                matched += 1;
            }
        }
        assert!(
            matched >= 3,
            "matched only {matched}/5 expected hits; events: {events:?}"
        );
    }

    #[test]
    fn music_mode_keeps_phrase_like_entry_after_percussion() {
        let sample_rate = 48_000;
        let mut samples = synthetic_ambient(sample_rate, 5.0);
        add_dhol_hits(&mut samples, sample_rate, &[0.50, 1.00, 1.50, 2.00]);
        add_phrase_entry(&mut samples, sample_rate, 3.20);
        let events = detect_events(&samples, sample_rate, DetectionMode::Music);
        assert!(
            events
                .iter()
                .any(|event| (event.time - 3.20).abs() <= 0.100),
            "missing phrase entry near 3.200; events: {events:?}"
        );
    }

    fn synthetic_ambient(sample_rate: u32, duration_seconds: f64) -> Vec<f32> {
        let len = (duration_seconds * sample_rate as f64).round() as usize;
        let mut samples = Vec::with_capacity(len);
        for i in 0..len {
            let t = i as f32 / sample_rate as f32;
            let hum = (std::f32::consts::TAU * 120.0 * t).sin() * 0.04
                + (std::f32::consts::TAU * 240.0 * t).sin() * 0.025
                + (std::f32::consts::TAU * 500.0 * t).sin() * 0.015
                + (std::f32::consts::TAU * 800.0 * t).sin() * 0.012
                + (std::f32::consts::TAU * 1500.0 * t).sin() * 0.008
                + (std::f32::consts::TAU * 3000.0 * t).sin() * 0.005;
            let noise = ((i as f32 * 17.3).sin() * 43.7).sin() * 0.020;
            samples.push(hum + noise);
        }
        samples
    }

    fn add_dhol_hits(samples: &mut [f32], sample_rate: u32, times: &[f64]) {
        for &time in times {
            let start = (time * sample_rate as f64).round() as usize;
            let hit_len = (0.120 * sample_rate as f64).round() as usize;
            for offset in 0..hit_len {
                let index = start + offset;
                if index >= samples.len() {
                    break;
                }
                let t = offset as f32 / sample_rate as f32;
                let low = (std::f32::consts::TAU * 82.0 * t).sin() * (-t * 28.0).exp();
                let body = (std::f32::consts::TAU * 420.0 * t).sin() * (-t * 38.0).exp();
                let attack_noise = if offset < 120 {
                    (((offset * 37) % 31) as f32 / 15.5 - 1.0) * (1.0 - offset as f32 / 120.0)
                } else {
                    0.0
                };
                samples[index] += (low * 0.85 + body * 0.40 + attack_noise * 0.30) * 1.8;
            }
        }
    }

    fn add_phrase_entry(samples: &mut [f32], sample_rate: u32, time: f64) {
        let start = (time * sample_rate as f64).round() as usize;
        let len = (0.600 * sample_rate as f64).round() as usize;
        for offset in 0..len {
            let index = start + offset;
            if index >= samples.len() {
                break;
            }
            let t = offset as f32 / sample_rate as f32;
            let fade = (t * 12.0).min(1.0) * (-t * 1.2).exp();
            let tone = (std::f32::consts::TAU * 310.0 * t).sin() * 0.50
                + (std::f32::consts::TAU * 620.0 * t).sin() * 0.35
                + (std::f32::consts::TAU * 1240.0 * t).sin() * 0.22
                + (std::f32::consts::TAU * 2480.0 * t).sin() * 0.12;
            samples[index] += tone * fade * 2.4;
        }
    }
}
