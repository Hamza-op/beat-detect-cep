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
    low: f32,
    mid: f32,
    high: f32,
    vocal: f32,
    wide: f32,
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
            track.codec_params.codec != CODEC_TYPE_NULL
                && track.codec_params.sample_rate.is_some()
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
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(error) => return Err(Box::new(error)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => push_decoded_as_mono(decoded, &mut mono),
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(Box::new(error)),
        }
    }

    Ok((mono, sample_rate))
}

fn push_decoded_as_mono(decoded: AudioBufferRef<'_>, mono: &mut Vec<f32>) {
    match decoded {
        AudioBufferRef::F32(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            buffer.chan(ch)[frame]
        }, mono),
        AudioBufferRef::U8(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::U16(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::U24(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::U32(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::S8(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::S16(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::S24(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::S32(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
        AudioBufferRef::F64(buffer) => push_planar_as_mono(buffer.spec().channels.count(), buffer.frames(), |ch, frame| {
            f32::from_sample(buffer.chan(ch)[frame])
        }, mono),
    }
}

fn push_planar_as_mono<F>(
    channels: usize,
    frames: usize,
    mut read: F,
    mono: &mut Vec<f32>,
) where
    F: FnMut(usize, usize) -> f32,
{
    if channels == 0 {
        return;
    }

    mono.reserve(frames);
    let gain = 1.0 / channels as f32;
    for frame in 0..frames {
        let mut sum = 0.0;
        for ch in 0..channels {
            sum += read(ch, frame);
        }
        mono.push(sum * gain);
    }
}

fn detect_events(samples: &[f32], sample_rate: u32, mode: DetectionMode) -> Vec<Event> {
    if sample_rate == 0 {
        return Vec::new();
    }

    let frames = band_energies(samples, sample_rate);
    if frames.len() < 5 {
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
        DetectionMode::Spikes => 0.280,
        DetectionMode::Music => 0.340,
        DetectionMode::Vocal => 0.750,
    };

    suppress_duplicates(peak_candidates, duplicate_gap)
        .into_iter()
        .filter(|(_, score)| *score >= 0.10)
        .map(|(time, score)| Event {
            time: round_to_millis(time),
            score: round_score(score),
        })
        .collect()
}

fn band_energies(samples: &[f32], sample_rate: u32) -> Vec<FrameEnergy> {
    if sample_rate == 0 {
        return Vec::new();
    }

    let sr = sample_rate as f32;
    let desired = (sr * 0.046).round() as usize;
    let window_size = desired.next_power_of_two().clamp(1024, 4096);
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

        let mut low = 0.0;
        let mut mid = 0.0;
        let mut high = 0.0;
        let mut vocal = 0.0;
        let mut wide = 0.0;

        for (bin, value) in buffer.iter().take(window_size / 2).enumerate().skip(1) {
            let freq = bin as f32 * sr / window_size as f32;
            let power = value.norm_sqr();
            if (40.0..=140.0).contains(&freq) {
                low += power;
            }
            if (140.0..=900.0).contains(&freq) {
                mid += power;
            }
            if (2_000.0..=6_000.0).contains(&freq) {
                high += power;
            }
            if (200.0..=3_000.0).contains(&freq) {
                vocal += power;
            }
            if (40.0..=8_000.0).contains(&freq) {
                wide += power;
            }
        }

        out.push(FrameEnergy {
            time: (start + window_size / 2) as f64 / sample_rate as f64,
            low: energy_scale(low),
            mid: energy_scale(mid),
            high: energy_scale(high),
            vocal: energy_scale(vocal),
            wide: energy_scale(wide),
            rms: energy_scale(sum_squares / window_size as f32),
            peak: energy_scale(peak),
        });

        start += hop;
    }

    out
}

fn spectral_novelty_scores(frames: &[FrameEnergy], mode: DetectionMode) -> Vec<f32> {
    let mut scores = Vec::with_capacity(frames.len());
    let mut low_base = frames[0].low;
    let mut mid_base = frames[0].mid;
    let mut high_base = frames[0].high;
    let mut vocal_base = frames[0].vocal;
    let mut wide_base = frames[0].wide;

    for frame in frames {
        let low_rise = positive_rise(frame.low, low_base);
        let mid_rise = positive_rise(frame.mid, mid_base);
        let high_rise = positive_rise(frame.high, high_base);
        let vocal_rise = positive_rise(frame.vocal, vocal_base);
        let wide_rise = positive_rise(frame.wide, wide_base);

        let percussion = low_rise * 0.34 + mid_rise * 0.18 + high_rise * 0.34 + wide_rise * 0.14;
        let quiet_zone = if percussion < 0.16 { 1.0 } else { 0.35 };
        let section_jump = wide_rise * 0.32;
        let vocal_or_melodic = vocal_rise * (0.18 + 0.32 * quiet_zone);
        let score = match mode {
            DetectionMode::Spikes => percussion * 0.88 + section_jump * 0.55,
            DetectionMode::Music => percussion * 0.46 + vocal_or_melodic * 1.15 + section_jump * 0.82,
            DetectionMode::Vocal => {
                let phrase_entry = vocal_rise * 0.82 + wide_rise * 0.22 + mid_rise * 0.18;
                let percussion_penalty = (low_rise * 0.34 + high_rise * 0.26).min(0.38);
                (phrase_entry - percussion_penalty * 0.42).max(0.0)
            }
        };
        scores.push(score.max(0.0));

        low_base = ema(low_base, frame.low, 0.045);
        mid_base = ema(mid_base, frame.mid, 0.045);
        high_base = ema(high_base, frame.high, 0.045);
        vocal_base = ema(vocal_base, frame.vocal, 0.040);
        wide_base = ema(wide_base, frame.wide, 0.035);
    }

    scores
}

fn envelope_onset_scores(frames: &[FrameEnergy], mode: DetectionMode) -> Vec<f32> {
    let mut scores = Vec::with_capacity(frames.len());
    let mut rms_base = frames[0].rms;
    let mut peak_base = frames[0].peak;

    for frame in frames {
        let rms_rise = positive_rise(frame.rms, rms_base);
        let peak_rise = positive_rise(frame.peak, peak_base);
        let score = match mode {
            DetectionMode::Spikes => peak_rise * 0.74 + rms_rise * 0.36,
            DetectionMode::Music => peak_rise * 0.42 + rms_rise * 0.62,
            DetectionMode::Vocal => rms_rise * 0.76 + peak_rise * 0.18,
        };
        scores.push(score.max(0.0));

        rms_base = ema(rms_base, frame.rms, 0.035);
        peak_base = ema(peak_base, frame.peak, 0.050);
    }

    scores
}

fn fuse_detector_scores(spectral: &[f32], envelope: &[f32], mode: DetectionMode) -> Vec<f32> {
    let spectral_norm = normalize_series(spectral, 0.985);
    let envelope_norm = normalize_series(envelope, 0.985);
    let mut fused = Vec::with_capacity(spectral.len().min(envelope.len()));

    for i in 0..spectral_norm.len().min(envelope_norm.len()) {
        let spec = local_max(&spectral_norm, i, 1);
        let env = local_max(&envelope_norm, i, 1);
        let agreement = spec.min(env);
        let support = (spec * env).sqrt();
        let strong_single = spec.max(env);

        let mut score = match mode {
            DetectionMode::Spikes => agreement * 0.88 + support * 0.22,
            DetectionMode::Music => agreement * 0.78 + support * 0.24 + spec * 0.08,
            DetectionMode::Vocal => agreement * 0.70 + support * 0.22 + spec * 0.12,
        };

        if agreement < 0.25 {
            score *= if strong_single > 0.92 { 0.62 } else { 0.35 };
        } else if agreement < 0.42 {
            score *= 0.78;
        }

        fused.push(score.max(0.0));
    }

    fused
}

fn normalize_series(values: &[f32], percentile: f32) -> Vec<f32> {
    let normalizer = robust_percentile(values, percentile).max(0.000_001);
    values
        .iter()
        .map(|value| soft_unit(*value / normalizer))
        .collect()
}

fn soft_unit(value: f32) -> f32 {
    let x = value.max(0.0);
    1.0 - (-x).exp()
}

fn calibrate_peak_scores(peaks: &mut [(f64, f32)]) {
    if peaks.is_empty() {
        return;
    }

    let raw = peaks.iter().map(|(_, score)| *score).collect::<Vec<_>>();
    let p25 = robust_percentile(&raw, 0.25);
    let p88 = robust_percentile(&raw, 0.88).max(p25 + 0.000_001);
    let p995 = robust_percentile(&raw, 0.995).max(p88 + 0.000_001);

    for (_, score) in peaks {
        let normalized = if *score <= p88 {
            let position = ((*score - p25) / (p88 - p25)).clamp(0.0, 1.0);
            0.18 + position.powf(0.85) * 0.62
        } else {
            let position = ((*score - p88) / (p995 - p88)).clamp(0.0, 1.0);
            0.80 + position.powf(0.60) * 0.19
        };
        *score = normalized.clamp(0.0, 0.99);
    }
}

fn local_max(values: &[f32], center: usize, radius: usize) -> f32 {
    let start = center.saturating_sub(radius);
    let end = (center + radius + 1).min(values.len());
    values[start..end]
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
}

fn pick_local_peaks(
    frames: &[FrameEnergy],
    scores: &[f32],
    mode: DetectionMode,
) -> Vec<(f64, f32)> {
    let mut nonzero = scores.iter().copied().filter(|v| *v > 0.0).collect::<Vec<_>>();
    if nonzero.is_empty() {
        return Vec::new();
    }
    nonzero.sort_by(|a, b| a.total_cmp(b));
    let floor_percentile = match mode {
        DetectionMode::Spikes => 0.70,
        DetectionMode::Music => 0.66,
        DetectionMode::Vocal => 0.72,
    };
    let floor = robust_percentile(&nonzero, floor_percentile).max(0.035);
    let mut peaks = Vec::new();

    for i in 1..scores.len() - 1 {
        if scores[i] < floor {
            continue;
        }
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

fn energy_scale(value: f32) -> f32 {
    (value + 1.0e-12).ln_1p()
}

fn positive_rise(current: f32, baseline: f32) -> f32 {
    (current - baseline).max(0.0)
}

fn ema(previous: f32, current: f32, alpha: f32) -> f32 {
    previous + (current - previous) * alpha
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
