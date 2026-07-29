#![allow(clippy::all, dead_code, unused_imports)]

pub mod audio;
mod cli;
pub mod detection;
pub mod model;

use cli::parse_args;
#[cfg(test)]
use cli::parse_args_from;
use std::error::Error;
use std::fs::File;
use std::path::Path;

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
use symphonia::core::conv::FromSample;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

const LOG_BANDS: usize = 40;
const MIN_ANALYSIS_HZ: f32 = 45.0;
const MAX_ANALYSIS_HZ: f32 = 10_000.0;

use model::Event;

#[derive(Clone, Copy)]
struct FrameEnergy {
    time: f64,
    bass: f32,
    body: f32,
    attack: f32,
    presence: f32,
    wide: f32,
    flux: f32,
    rms: f32,
    peak: f32,
    log_bands: [f32; LOG_BANDS],
}

struct DropRiseCandidateContext<'a> {
    samples: &'a [f32],
    sample_rate: u32,
    frames: &'a [FrameEnergy],
    drop_rise_scores: &'a [f32],
    stable_scores: &'a [f32],
    min_score: f32,
    lag: usize,
}

pub fn run() -> Result<(), Box<dyn Error>> {
    std::panic::set_hook(Box::new(|panic_info| {
        eprintln!("internal analyzer error: {panic_info}");
    }));

    let options = parse_args()?;
    if options.help {
        println!(
            "{}",
            "usage: beat_analyzer [--start seconds] [--duration seconds] <media-file-path>"
        );
        return Ok(());
    }
    if options.version {
        println!("beat_analyzer {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    if !Path::new(&options.media_path).exists() {
        return Err(format!("media file does not exist: {}", options.media_path).into());
    }

    let (analysis_samples, sample_rate, analysis_offset) = decode_mono_audio(
        &options.media_path,
        options.start_seconds,
        options.duration_seconds,
    )?;

    let mut events = detect_events(&analysis_samples, sample_rate);
    events = select_major_hit_markers(events);
    if analysis_offset > 0.0 {
        for event in &mut events {
            event.time = round_to_millis(event.time + analysis_offset);
        }
    }
    events.retain(|event| event.time.is_finite() && event.time >= 0.0 && event.score.is_finite());
    for event in &mut events {
        event.score = event.score.clamp(0.0, 1.0);
    }
    events.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    println!("{}", serde_json::to_string(&events)?);
    Ok(())
}

pub fn decode_mono_audio(
    media_path: &str,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
) -> Result<(Vec<f32>, u32, f64), Box<dyn Error>> {
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
    let mut decoder = match get_codecs().make(&track.codec_params, &DecoderOptions::default()) {
        Ok(decoder) => decoder,
        Err(_error) if track.codec_params.codec == CODEC_TYPE_OPUS => {
            return Err(
                "Opus/WebA audio is not supported by the bundled analyzer decoder. Convert it to WAV, AAC, MP3, or MP4/M4A and analyze again."
                    .into(),
            );
        }
        Err(error) => return Err(Box::new(error)),
    };

    let start = start_seconds.unwrap_or(0.0).max(0.0);
    let time_base = track
        .codec_params
        .time_base
        .unwrap_or_else(|| symphonia::core::units::TimeBase::new(1, sample_rate));

    // Seek to start_seconds if requested and > 0
    if start > 0.0 {
        let seek_time = symphonia::core::units::Time::new(start as u64, start.fract());
        if format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: seek_time,
                    track_id: Some(track_id),
                },
            )
            .is_ok()
        {
            decoder.reset();
        }
    }

    let mut mono = Vec::new();
    let mut first_packet_sample_index: Option<usize> = None;

    let target_start_sample = (start * sample_rate as f64).round() as usize;
    let target_end_sample = match duration_seconds {
        Some(duration) => {
            if !duration.is_finite() || duration <= 0.0 {
                return Err("selected clip duration must be greater than zero".into());
            }
            ((start + duration) * sample_rate as f64).round() as usize
        }
        None => usize::MAX,
    };

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

        if first_packet_sample_index.is_none() {
            let packet_time = time_base.calc_time(packet.ts());
            let packet_seconds = packet_time.seconds as f64 + packet_time.frac;
            first_packet_sample_index =
                Some((packet_seconds * sample_rate as f64).round() as usize);
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                push_decoded_as_mono(decoded, &mut mono);
            }
            // Malformed / corrupted packets — log to stderr, skip frame.
            Err(SymphoniaError::DecodeError(ref msg)) => {
                eprintln!("[beat_analyzer] skipping malformed packet: {msg}");
                continue;
            }
            Err(error) => return Err(Box::new(error)),
        }

        let start_idx = first_packet_sample_index.unwrap_or(0);
        let current_decoded_len = mono.len();
        if start_idx + current_decoded_len >= target_end_sample {
            break;
        }
    }

    let start_idx = first_packet_sample_index.unwrap_or(0);
    let discard = target_start_sample.saturating_sub(start_idx);
    let mut final_mono = if mono.len() > discard {
        mono[discard..].to_vec()
    } else {
        Vec::new()
    };

    let total_needed = target_end_sample.saturating_sub(target_start_sample);
    if final_mono.len() > total_needed {
        final_mono.truncate(total_needed);
    }

    if final_mono.is_empty() {
        return Err("selected clip range contains no decodable audio samples".into());
    }

    let actual_start_sample = start_idx + discard;
    let actual_offset_seconds = actual_start_sample as f64 / sample_rate as f64;

    Ok((final_mono, sample_rate, actual_offset_seconds))
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

pub fn detect_events(samples: &[f32], sample_rate: u32) -> Vec<Event> {
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
    detect_beat_grid_events(samples, sample_rate, &frames)
}

fn select_major_hit_markers(mut events: Vec<Event>) -> Vec<Event> {
    if events.len() < 3 {
        return events;
    }

    events.sort_by(|a, b| a.time.total_cmp(&b.time));

    const CONTEXT_SECONDS: f64 = 6.0;
    const PEAK_RADIUS_SECONDS: f64 = 1.25;
    const GLOBAL_MAJOR_PERCENTILE: f32 = 0.70;
    let global_scores = events.iter().map(|event| event.score).collect::<Vec<_>>();
    let global_major_floor = robust_percentile(&global_scores, GLOBAL_MAJOR_PERCENTILE);
    let mut selected = Vec::new();

    for (index, event) in events.iter().enumerate() {
        // Scores are rank-calibrated over the decoded beat grid. A global
        // percentile floor removes isolated weak candidates in sparse
        // passages while remaining relative to each song's dynamics.
        if event.score < global_major_floor {
            continue;
        }

        let context_scores = events
            .iter()
            .filter(|candidate| (candidate.time - event.time).abs() <= CONTEXT_SECONDS)
            .map(|candidate| candidate.score)
            .collect::<Vec<_>>();

        // Sparse passages already contain only meaningful candidates. In
        // denser passages, require a beat to sit in the strongest local fifth
        // and rise clearly above the surrounding beat strength.
        if context_scores.len() >= 6 {
            let local_median = robust_percentile(&context_scores, 0.50);
            let local_strong = robust_percentile(&context_scores, 0.85);
            let threshold = local_strong.max(local_median + 0.08);
            if event.score < threshold {
                continue;
            }
        }

        let is_local_peak = events.iter().enumerate().all(|(other_index, candidate)| {
            if other_index == index || (candidate.time - event.time).abs() > PEAK_RADIUS_SECONDS {
                return true;
            }
            candidate.score < event.score
                || ((candidate.score - event.score).abs() < f32::EPSILON && other_index > index)
        });
        if is_local_peak {
            selected.push(event.clone());
        }
    }

    if selected.is_empty() {
        if let Some(strongest) = events
            .into_iter()
            .max_by(|left, right| left.score.total_cmp(&right.score))
        {
            selected.push(strongest);
        }
    }
    selected
}

struct FramePreData {
    time: f64,
    sum_squares: f32,
    peak: f32,
    mags: Vec<f32>,
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

    let mut starts = Vec::new();
    let mut start = 0;
    while start + window_size <= samples.len() {
        starts.push(start);
        start += hop;
    }

    use rayon::prelude::*;

    let mut prev_mags = vec![0.0_f32; window_size / 2];
    let mut out = Vec::with_capacity(starts.len());
    let chunk_size = (rayon::current_num_threads() * 4).max(16);

    for chunk in starts.chunks(chunk_size) {
        let pre_data: Vec<FramePreData> = chunk
            .par_iter()
            .map(|&start| {
                let mut buffer = vec![Complex::new(0.0, 0.0); window_size];
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

                let mut mags = vec![0.0_f32; window_size / 2];
                for (bin, value) in buffer.iter().take(window_size / 2).enumerate().skip(1) {
                    mags[bin] = value.norm();
                }

                FramePreData {
                    time: (start + window_size / 2) as f64 / sample_rate as f64,
                    sum_squares,
                    peak,
                    mags,
                }
            })
            .collect();

        for data in pre_data {
            let mut bass = 0.0;
            let mut body = 0.0;
            let mut attack = 0.0;
            let mut presence = 0.0;
            let mut wide = 0.0;
            let mut log_band_power = [0.0_f32; LOG_BANDS];
            let mut log_band_bins = [0_usize; LOG_BANDS];
            let mut bass_bins = 0;
            let mut body_bins = 0;
            let mut attack_bins = 0;
            let mut presence_bins = 0;
            let mut wide_bins = 0;
            let mut flux = 0.0;

            for bin in 1..(window_size / 2) {
                let mag = data.mags[bin];
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
                    presence += power;
                    presence_bins += 1;
                }
                if (40.0..=10_000.0).contains(&freq) {
                    wide += power;
                    wide_bins += 1;
                }
                if let Some(band) = log_band_index(freq) {
                    log_band_power[band] += power;
                    log_band_bins[band] += 1;
                }
            }

            let mut log_bands = [0.0_f32; LOG_BANDS];
            for band in 0..LOG_BANDS {
                log_bands[band] = band_energy(log_band_power[band], log_band_bins[band]);
            }

            out.push(FrameEnergy {
                time: data.time,
                bass: band_energy(bass, bass_bins),
                body: band_energy(body, body_bins),
                attack: band_energy(attack, attack_bins),
                presence: band_energy(presence, presence_bins),
                wide: band_energy(wide, wide_bins),
                flux: energy_scale(flux / (window_size / 2) as f32),
                rms: energy_scale(data.sum_squares / window_size as f32),
                peak: energy_scale(data.peak),
                log_bands,
            });
        }
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

fn log_band_index(freq: f32) -> Option<usize> {
    if !(MIN_ANALYSIS_HZ..=MAX_ANALYSIS_HZ).contains(&freq) {
        return None;
    }

    let min_ln = MIN_ANALYSIS_HZ.ln();
    let max_ln = MAX_ANALYSIS_HZ.ln();
    let position = ((freq.ln() - min_ln) / (max_ln - min_ln)).clamp(0.0, 0.999_999);
    Some((position * LOG_BANDS as f32) as usize)
}

fn log_band_center_hz(band: usize) -> f32 {
    let min_ln = MIN_ANALYSIS_HZ.ln();
    let max_ln = MAX_ANALYSIS_HZ.ln();
    let t = (band as f32 + 0.5) / LOG_BANDS as f32;
    (min_ln + t * (max_ln - min_ln)).exp()
}

fn spectral_novelty_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    let mut scores = Vec::with_capacity(frames.len());
    let mut bass_base = frames[0].bass;
    let mut body_base = frames[0].body;
    let mut attack_base = frames[0].attack;
    let mut presence_base = frames[0].presence;
    let mut wide_base = frames[0].wide;
    let mut flux_base = frames[0].flux;

    for i in 0..frames.len() {
        let frame = frames[i];
        let previous = if i == 0 { frame } else { frames[i - 1] };
        let bass_rise = positive_rise(frame.bass, bass_base);
        let body_rise = positive_rise(frame.body, body_base);
        let attack_rise = positive_rise(frame.attack, attack_base);
        let presence_rise = positive_rise(frame.presence, presence_base);
        let wide_rise = positive_rise(frame.wide, wide_base);
        let flux_rise = positive_rise(frame.flux, flux_base);

        let bass_snap = positive_rise(frame.bass, previous.bass);
        let body_snap = positive_rise(frame.body, previous.body);
        let attack_snap = positive_rise(frame.attack, previous.attack);
        let presence_snap = positive_rise(frame.presence, previous.presence);
        let wide_snap = positive_rise(frame.wide, previous.wide);
        let flux_snap = positive_rise(frame.flux, previous.flux);

        let percussion = bass_rise * 0.38
            + body_rise * 0.25
            + attack_rise * 0.27
            + wide_rise * 0.04
            + flux_rise * 0.18;
        let transient = bass_snap * 0.30
            + body_snap * 0.20
            + attack_snap * 0.32
            + wide_snap * 0.06
            + flux_snap * 0.26;
        let section_jump =
            wide_rise * 0.32 + wide_snap * 0.16 + bass_rise * 0.10 + flux_rise * 0.25;
        let quiet_zone = if percussion + transient < 0.18 {
            1.0
        } else {
            0.38
        };
        let midrange_motion =
            presence_rise * (0.30 + 0.42 * quiet_zone) + presence_snap * (0.14 + 0.18 * quiet_zone);
        let score =
            percussion * 0.64 + transient * 0.66 + section_jump * 0.32 + midrange_motion * 0.16;
        scores.push(score.max(0.0));

        // Use dual-rate EMA for baseline tracking: resists peaks (slow up), tracks noise floor (fast down, but not too fast to avoid ghost notes)
        bass_base = dual_rate_ema(bass_base, frame.bass, 0.015, 0.06);
        body_base = dual_rate_ema(body_base, frame.body, 0.015, 0.06);
        attack_base = dual_rate_ema(attack_base, frame.attack, 0.020, 0.08);
        presence_base = dual_rate_ema(presence_base, frame.presence, 0.012, 0.05);
        wide_base = dual_rate_ema(wide_base, frame.wide, 0.010, 0.05);
        flux_base = dual_rate_ema(flux_base, frame.flux, 0.025, 0.10);
    }

    scores
}

fn envelope_onset_scores(frames: &[FrameEnergy]) -> Vec<f32> {
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
        let score = peak_rise * 0.42 + peak_snap * 0.36 + rms_rise * 0.38 + rms_snap * 0.18;
        scores.push(score.max(0.0));

        rms_base = dual_rate_ema(rms_base, frame.rms, 0.015, 0.06);
        peak_base = dual_rate_ema(peak_base, frame.peak, 0.020, 0.08);
    }

    scores
}

fn superflux_onset_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    if frames.len() < 3 {
        return vec![0.0; frames.len()];
    }

    let mut scores = vec![0.0_f32; frames.len()];
    for i in 2..frames.len() {
        let mut total = 0.0_f32;
        let mut weight_sum = 0.0_f32;

        for band in 0..LOG_BANDS {
            let current = frames[i].log_bands[band];
            let previous_max = local_previous_band_max(frames, i, band, 1)
                .max(local_previous_band_max(frames, i, band, 2) * 0.86);
            let diff = (current - previous_max).max(0.0);
            if diff <= 0.0 {
                continue;
            }

            let center_hz = log_band_center_hz(band);
            let weight = onset_band_weight(center_hz);
            total += diff * weight;
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            scores[i] = total / weight_sum;
        }
    }

    scores
}

fn local_previous_band_max(frames: &[FrameEnergy], index: usize, band: usize, lag: usize) -> f32 {
    if index < lag {
        return 0.0;
    }

    let source = &frames[index - lag].log_bands;
    let start = band.saturating_sub(1);
    let end = (band + 1).min(LOG_BANDS - 1);
    let mut best = 0.0_f32;
    for value in source.iter().take(end + 1).skip(start) {
        best = best.max(*value);
    }
    best
}

fn onset_band_weight(freq: f32) -> f32 {
    let dhol_bass = gaussian_weight(freq, 90.0, 0.62);
    let tabla_body = gaussian_weight(freq, 430.0, 0.72);
    let slap_attack = gaussian_weight(freq, 2_800.0, 0.95);
    let mid_presence = gaussian_weight(freq, 1_100.0, 1.10);
    let upper_presence = gaussian_weight(freq, 4_200.0, 1.00);

    0.18 + dhol_bass * 1.08
        + tabla_body * 0.92
        + slap_attack * 0.82
        + mid_presence * 0.18
        + upper_presence * 0.22
}

fn gaussian_weight(freq: f32, center_hz: f32, octave_width: f32) -> f32 {
    if freq <= 0.0 || center_hz <= 0.0 || octave_width <= 0.0 {
        return 0.0;
    }
    let distance_octaves = (freq / center_hz).log2();
    (-0.5 * (distance_octaves / octave_width).powi(2)).exp()
}

fn fuse_detector_scores(spectral: &[f32], envelope: &[f32], superflux: &[f32]) -> Vec<f32> {
    let spectral_norm = normalize_series(spectral, 0.985);
    let envelope_norm = normalize_series(envelope, 0.985);
    let superflux_norm = normalize_series(superflux, 0.985);
    let len = spectral_norm
        .len()
        .min(envelope_norm.len())
        .min(superflux_norm.len());
    let mut fused = Vec::with_capacity(len);

    for i in 0..len {
        let spec = spectral_norm[i];
        let env = envelope_norm[i];
        let flux = superflux_norm[i];
        let agreement = spec.min(env).max(flux.min(env) * 0.92);
        let support = ((spec.max(flux) * env).sqrt() + (spec * flux).sqrt() * 0.45) / 1.45;
        let strong_single = spec.max(env).max(flux);

        // SuperFlux catches timbral and tabla/dhol attacks that envelope-only
        // scoring can miss, while agreement keeps sustained noise from winning.
        let mut score =
            agreement * 0.58 + support * 0.34 + flux * 0.25 + env * 0.16 + strong_single * 0.04;

        if agreement < 0.10 {
            score *= if strong_single > 0.84 { 0.62 } else { 0.34 };
        } else if agreement < 0.24 {
            score *= 0.78;
        }

        fused.push(score.max(0.0));
    }

    fused
}

fn drop_rise_transition_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    if frames.len() < 24 {
        return vec![0.0; frames.len()];
    }

    let frame_step = median_frame_step_seconds(frames);
    if frame_step <= 0.0 {
        return vec![0.0; frames.len()];
    }

    let prior_window = ((4.20 / frame_step).round() as usize).clamp(24, 180);
    let quiet_window = ((0.85 / frame_step).round() as usize).clamp(4, 36);
    let current_window = ((0.20 / frame_step).round() as usize).clamp(2, 10);
    let activities = frames.iter().map(frame_activity).collect::<Vec<_>>();
    let global_reference = robust_percentile(&activities, 0.70).max(1.0e-6);
    let mut scores = vec![0.0_f32; frames.len()];

    for (i, score_slot) in scores
        .iter_mut()
        .enumerate()
        .take(frames.len())
        .skip(prior_window + quiet_window)
    {
        let prior_start = i - prior_window - quiet_window;
        let prior_end = i - quiet_window;
        let quiet_start = i - quiet_window;
        let quiet_end = i;
        let current_end = (i + current_window).min(frames.len());

        let prior = percentile_activity(&activities, prior_start, prior_end, 0.96).max(1.0e-6);
        let quiet = median_activity(&activities, quiet_start, quiet_end).max(1.0e-6);
        let current = max_activity(&activities, i, current_end).max(1.0e-6);
        let drop_depth = ((prior - quiet) / prior).clamp(0.0, 1.0);
        let rise_strength = ((current - quiet) / quiet.max(global_reference * 0.08)).max(0.0);
        let recovery = (current / prior.max(global_reference * 0.20)).clamp(0.0, 1.8);
        let current_presence = (current / global_reference).clamp(0.0, 1.8);
        let onset = drop_rise_onset_strength(frames, i, quiet_start, quiet_end);

        if drop_depth >= 0.18 && rise_strength >= 0.26 && onset >= 0.16 && current_presence >= 0.36
        {
            let score = drop_depth * 0.40
                + rise_strength.min(1.8) * 0.24
                + recovery.min(1.4) * 0.18
                + onset.min(1.6) * 0.22;
            *score_slot = score.max(0.0);
        }
    }

    scores
}

fn drop_rise_onset_strength(
    frames: &[FrameEnergy],
    index: usize,
    quiet_start: usize,
    quiet_end: usize,
) -> f32 {
    if frames.is_empty() || index >= frames.len() {
        return 0.0;
    }

    let quiet = frame_medians(frames, quiet_start, quiet_end);
    let frame = frames[index];
    let bass = positive_rise(frame.bass, quiet.bass);
    let body = positive_rise(frame.body, quiet.body);
    let attack = positive_rise(frame.attack, quiet.attack);
    let wide = positive_rise(frame.wide, quiet.wide);
    let rms = positive_rise(frame.rms, quiet.rms);
    let peak = positive_rise(frame.peak, quiet.peak);

    bass * 0.24 + body * 0.18 + attack * 0.22 + wide * 0.12 + rms * 0.16 + peak * 0.08
}

fn frame_activity(frame: &FrameEnergy) -> f32 {
    frame.wide * 0.34
        + frame.bass * 0.22
        + frame.body * 0.16
        + frame.rms * 0.14
        + frame.presence * 0.10
        + frame.attack * 0.04
}

fn median_activity(values: &[f32], start: usize, end: usize) -> f32 {
    let end = end.min(values.len());
    if values.is_empty() || start >= end {
        return 0.0;
    }

    let mut window = values[start..end]
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if window.is_empty() {
        return 0.0;
    }

    window.sort_by(|a, b| a.total_cmp(b));
    window[window.len() / 2]
}

fn percentile_activity(values: &[f32], start: usize, end: usize, percentile: f32) -> f32 {
    let end = end.min(values.len());
    if values.is_empty() || start >= end {
        return 0.0;
    }

    let mut window = values[start..end]
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if window.is_empty() {
        return 0.0;
    }

    window.sort_by(|a, b| a.total_cmp(b));
    percentile_sorted(&window, percentile)
}

fn max_activity(values: &[f32], start: usize, end: usize) -> f32 {
    let end = end.min(values.len());
    if values.is_empty() || start >= end {
        return 0.0;
    }

    values[start..end]
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold(0.0_f32, f32::max)
}

fn combine_transition_scores(base: &[f32], transition: &[f32]) -> Vec<f32> {
    let len = base.len().min(transition.len());
    let mut combined = Vec::with_capacity(len);
    for i in 0..len {
        combined.push(base[i] + transition[i] * 0.34);
    }
    combined
}

fn locally_stabilize_scores(frames: &[FrameEnergy], scores: &[f32]) -> Vec<f32> {
    if frames.len() < 8 || scores.len() < 8 {
        return scores.to_vec();
    }

    let frame_step = median_frame_step_seconds(frames);
    if frame_step <= 0.0 {
        return scores.to_vec();
    }

    let half_window_seconds = 8.0;
    let half_window = ((half_window_seconds / frame_step).round() as usize).clamp(16, 180);
    let global_reference = robust_percentile(scores, 0.72).max(1.0e-6);
    let global_activity_floor = global_reference * 0.18;
    let k_mad = 1.05;

    let mut stabilized = Vec::with_capacity(scores.len());
    for i in 0..scores.len() {
        let lo = i.saturating_sub(half_window);
        let hi = (i + half_window + 1).min(scores.len());
        let mut window = scores[lo..hi]
            .iter()
            .copied()
            .filter(|value| value.is_finite() && *value > 0.0)
            .collect::<Vec<_>>();
        if window.len() < 4 {
            stabilized.push(0.0);
            continue;
        }

        window.sort_by(|a, b| a.total_cmp(b));
        let median = percentile_sorted(&window, 0.50);
        let p85 = percentile_sorted(&window, 0.85);
        let p97 = percentile_sorted(&window, 0.97).max(p85 + 1.0e-6);
        let mad = median_absolute_deviation_sorted(&window, median).max(1.0e-6);

        if p85 < global_activity_floor {
            stabilized.push(0.0);
            continue;
        }

        let threshold = (median + k_mad * mad).max(p85 * 0.42);
        let score = scores[i];
        if score <= threshold {
            stabilized.push(0.0);
            continue;
        }

        let local_ratio = ((score - threshold) / (p97 - threshold).max(1.0e-6)).clamp(0.0, 1.8);
        let activity_confidence =
            ((p85 - global_activity_floor) / global_reference).clamp(0.35, 1.0);
        stabilized.push(soft_compress(local_ratio) * activity_confidence);
    }

    stabilized
}

fn frame_medians(frames: &[FrameEnergy], start: usize, end: usize) -> FrameEnergy {
    if frames.is_empty() {
        return FrameEnergy {
            time: 0.0,
            bass: 0.0,
            body: 0.0,
            attack: 0.0,
            presence: 0.0,
            wide: 0.0,
            flux: 0.0,
            rms: 0.0,
            peak: 0.0,
            log_bands: [0.0; LOG_BANDS],
        };
    }

    let end = end.min(frames.len());
    if start >= end {
        return frames[start.min(frames.len() - 1)];
    }

    FrameEnergy {
        time: frames[(start + end - 1) / 2].time,
        bass: median_by(frames, start, end, |frame| frame.bass),
        body: median_by(frames, start, end, |frame| frame.body),
        attack: median_by(frames, start, end, |frame| frame.attack),
        presence: median_by(frames, start, end, |frame| frame.presence),
        wide: median_by(frames, start, end, |frame| frame.wide),
        flux: median_by(frames, start, end, |frame| frame.flux),
        rms: median_by(frames, start, end, |frame| frame.rms),
        peak: median_by(frames, start, end, |frame| frame.peak),
        log_bands: [0.0; LOG_BANDS],
    }
}

fn median_by<F>(frames: &[FrameEnergy], start: usize, end: usize, read: F) -> f32
where
    F: Fn(&FrameEnergy) -> f32,
{
    let end = end.min(frames.len());
    if frames.is_empty() || start >= end {
        return 0.0;
    }
    let mut values = frames[start..end]
        .iter()
        .map(read)
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    values[values.len() / 2]
}

fn detect_beat_grid_events(
    samples: &[f32],
    sample_rate: u32,
    frames: &[FrameEnergy],
) -> Vec<Event> {
    let spectral_scores = spectral_novelty_scores(frames);
    let envelope_scores = envelope_onset_scores(frames);
    let superflux_scores = superflux_onset_scores(frames);
    let drop_rise_scores = drop_rise_transition_scores(frames);
    let raw_scores = combine_transition_scores(
        &fuse_detector_scores(&spectral_scores, &envelope_scores, &superflux_scores),
        &drop_rise_scores,
    );
    let reinforced_scores = reinforce_rhythmic_scores(frames, &raw_scores);
    let stable_scores = locally_stabilize_scores(frames, &reinforced_scores);
    let frame_step = median_frame_step_seconds(frames);
    if frame_step <= 0.0 {
        return Vec::new();
    }

    // The onset detectors answer "where did the sound change?", while the
    // tracker below answers "which of those changes form the musical pulse?".
    // Keep these responsibilities separate: a beat may be implied by the
    // surrounding pulse even when its own transient is weak.
    let tracking_scores = beat_tracking_scores(&raw_scores, &stable_scores);
    let norm = normalize_series(&tracking_scores, 0.985);
    let tempo_evidence = normalize_series(&stable_scores, 0.985);
    let Some(global_lag) = estimate_beat_lag(&tempo_evidence, frame_step) else {
        return Vec::new();
    };
    // Autocorrelation commonly produces a strong half-time candidate when a
    // song has a kick on every other quarter note. Keep the whole-track lag
    // for activity-region splitting, but let the pulse decoder choose the
    // faster harmonic when the waveform repeatedly supports it.
    let pulse_evidence = normalize_series(&raw_scores, 0.985);
    let pulse_lag = prefer_faster_harmonic_lag(&pulse_evidence, global_lag, frame_step);

    let mut beats = Vec::new();
    for (start, end) in active_rhythm_regions(frames, &stable_scores, global_lag, frame_step) {
        let region_scores = &norm[start..end];
        let lag_curve = estimate_local_beat_lags(region_scores, frame_step, pulse_lag);
        let beat_frames = dynamic_programming_beat_path(region_scores, &lag_curve);

        for relative_index in beat_frames {
            let index = start + relative_index;
            if index >= frames.len() {
                continue;
            }
            let frame = frames[index];
            let snapped = snap_event_time(samples, sample_rate, frame.time);
            let evidence = tracking_scores.get(index).copied().unwrap_or(0.0);
            beats.push((snapped, evidence));
        }
    }

    // Adjacent rhythm regions can overlap at their padded edges. De-duplicate
    // only near-identical outputs, not legitimate fast beats.
    let min_tracked_period = 60.0 / 210.0;
    let mut deduped = suppress_duplicates(beats, min_tracked_period * 0.42);
    calibrate_beat_grid_scores(&mut deduped);
    deduped
        .into_iter()
        .map(|(time, score)| Event {
            time: round_to_millis(time),
            score: round_score(score),
        })
        .collect()
}

fn beat_tracking_scores(raw_scores: &[f32], stable_scores: &[f32]) -> Vec<f32> {
    let raw = normalize_series(raw_scores, 0.985);
    let stable = normalize_series(stable_scores, 0.985);
    let len = raw.len().min(stable.len());
    let mut tracking = Vec::with_capacity(len);

    for i in 0..len {
        let local_peak = stable[i];
        let onset = raw[i];
        let score = if local_peak > 0.0 {
            local_peak * 0.72 + onset * 0.28
        } else {
            // Preserve a small amount of sub-threshold evidence. Dynamic
            // programming can use it to carry the pulse through a soft beat,
            // but it is too small to create an active section by itself.
            onset * 0.10
        };
        tracking.push(score.max(0.0));
    }

    tracking
}

fn active_rhythm_regions(
    frames: &[FrameEnergy],
    stable_scores: &[f32],
    global_lag: usize,
    frame_step: f64,
) -> Vec<(usize, usize)> {
    if frames.is_empty() || stable_scores.is_empty() || global_lag == 0 || frame_step <= 0.0 {
        return Vec::new();
    }

    let positive = stable_scores
        .iter()
        .enumerate()
        .filter_map(|(index, score)| {
            (*score > 0.0 && has_direct_onset_evidence(frames, index, global_lag.clamp(4, 32)))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if positive.len() < 2 {
        return Vec::new();
    }

    // Split only on a genuine breakdown. Normal syncopation and a few missing
    // attacks remain in the same rhythmic region and are bridged by the beat
    // tracker. Long quiet spans are not filled with synthetic markers.
    let max_gap = global_lag
        .saturating_mul(3)
        .max((1.1 / frame_step).round() as usize);
    let edge_padding = global_lag;
    let mut regions = Vec::new();
    let mut first = positive[0];
    let mut previous = positive[0];
    let mut evidence_count = 1_usize;

    for index in positive.into_iter().skip(1) {
        if index.saturating_sub(previous) > max_gap {
            if evidence_count >= 2 {
                regions.push((
                    first.saturating_sub(edge_padding),
                    (previous + edge_padding + 1).min(stable_scores.len()),
                ));
            }
            first = index;
            evidence_count = 1;
        } else {
            evidence_count += 1;
        }
        previous = index;
    }

    if evidence_count >= 2 {
        regions.push((
            first.saturating_sub(edge_padding),
            (previous + edge_padding + 1).min(stable_scores.len()),
        ));
    }

    regions
}

fn prefer_faster_harmonic_lag(values: &[f32], lag: usize, frame_step: f64) -> usize {
    if lag < 2 || frame_step <= 0.0 {
        return lag;
    }

    let faster = lag / 2;
    if faster < 2 {
        return lag;
    }

    let base_correlation = normalized_lag_correlation(values, lag);
    let faster_correlation = normalized_lag_correlation(values, faster);
    if base_correlation < 0.08 || faster_correlation < 0.22 {
        return lag;
    }

    let faster_bpm = 60.0 / (faster as f64 * frame_step);
    if !(88.0..=205.0).contains(&faster_bpm) {
        return lag;
    }

    // Prefer the quarter-note grid when the faster harmonic has substantial
    // repeated evidence. A slower grid remains valid when its half-lag has no
    // meaningful correlation, which protects genuinely slow material.
    let relative_support = faster_correlation / base_correlation.max(1.0e-6);
    if relative_support >= 0.70 || faster_correlation >= base_correlation + 0.02 {
        faster
    } else {
        lag
    }
}

fn estimate_local_beat_lags(scores: &[f32], frame_step: f64, global_lag: usize) -> Vec<usize> {
    if scores.is_empty() || frame_step <= 0.0 || global_lag == 0 {
        return vec![global_lag.max(1); scores.len()];
    }

    let min_lag = ((60.0 / 210.0) / frame_step).round().max(2.0) as usize;
    let max_lag = ((60.0 / 55.0) / frame_step)
        .round()
        .min((scores.len().saturating_sub(1)) as f64) as usize;
    if min_lag >= max_lag {
        return vec![global_lag; scores.len()];
    }

    let anchor_step = ((2.0 / frame_step).round() as usize).max(1);
    let half_window = ((5.0 / frame_step).round() as usize).max(global_lag * 3);
    let mut anchors = Vec::new();
    let mut anchor = 0_usize;
    let mut previous_lag = global_lag.clamp(min_lag, max_lag);

    while anchor < scores.len() {
        let lo = anchor.saturating_sub(half_window);
        let hi = (anchor + half_window + 1).min(scores.len());
        let local = &scores[lo..hi];
        let mut best_lag = previous_lag;
        let mut best_score = f32::NEG_INFINITY;

        for lag in min_lag..=max_lag.min(local.len().saturating_sub(1)) {
            let corr = normalized_lag_correlation(local, lag);
            if corr <= 0.0 {
                continue;
            }

            let bpm = 60.0 / (lag as f64 * frame_step);
            let tempo_prior = (-0.5 * (bpm / 120.0).log2().powi(2) / 0.78_f64.powi(2)).exp() as f32;
            let continuity =
                ((lag as f64 / previous_lag.max(1) as f64).log2().abs() as f32).min(2.0);
            let global_distance =
                ((lag as f64 / global_lag.max(1) as f64).log2().abs() as f32).min(2.0);
            let harmonic_support = if lag * 2 < local.len() {
                normalized_lag_correlation(local, lag * 2) * 0.16
            } else {
                0.0
            };
            let subdivision_evidence = if lag >= min_lag.saturating_mul(2) {
                normalized_lag_correlation(local, lag / 2)
            } else {
                0.0
            };
            let score = corr * (0.78 + tempo_prior * 0.22) + harmonic_support
                - subdivision_evidence * 0.20
                - continuity * 0.11
                - global_distance * 0.035;

            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }

        // A local estimate with little periodic evidence is less reliable than
        // the whole-track estimate.
        if best_score < 0.10 {
            best_lag = previous_lag;
        }
        best_lag = prefer_faster_harmonic_lag(local, best_lag, frame_step);
        // Once the whole-track evidence resolves a fast pulse (roughly
        // quarter-note territory), do not let a local autocorrelation valley
        // silently fall back to an unrelated half-time path. Normal tempo
        // drift remains allowed; only a large excursion is corrected.
        let preferred_bpm = 60.0 / (global_lag as f64 * frame_step);
        let slow_limit = (global_lag as f64 * 1.45).round() as usize;
        if preferred_bpm >= 90.0 && best_lag > slow_limit {
            best_lag = global_lag;
        }
        anchors.push((anchor, best_lag));
        previous_lag = best_lag;
        anchor = anchor.saturating_add(anchor_step);
    }

    if anchors.last().map(|entry| entry.0).unwrap_or(0) != scores.len() - 1 {
        anchors.push((scores.len() - 1, previous_lag));
    }

    let mut curve = vec![global_lag; scores.len()];
    for pair in anchors.windows(2) {
        let (left_index, left_lag) = pair[0];
        let (right_index, right_lag) = pair[1];
        let width = right_index.saturating_sub(left_index).max(1);
        for (offset, slot) in curve[left_index..=right_index].iter_mut().enumerate() {
            let t = offset as f64 / width as f64;
            *slot = ((left_lag as f64 * (1.0 - t) + right_lag as f64 * t).round() as usize)
                .clamp(min_lag, max_lag);
        }
    }

    curve
}

fn normalized_lag_correlation(values: &[f32], lag: usize) -> f32 {
    if lag == 0 || values.len() <= lag {
        return 0.0;
    }

    let mut cross = 0.0_f32;
    let mut left_energy = 0.0_f32;
    let mut right_energy = 0.0_f32;
    for index in lag..values.len() {
        let left = values[index].max(0.0);
        let right = values[index - lag].max(0.0);
        if left < 0.025 && right < 0.025 {
            continue;
        }
        cross += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }

    cross / (left_energy.sqrt() * right_energy.sqrt()).max(1.0e-6)
}

fn dynamic_programming_beat_path(scores: &[f32], lag_curve: &[usize]) -> Vec<usize> {
    if scores.len() < 3 || lag_curve.len() != scores.len() {
        return Vec::new();
    }

    let local_scores = smoothed_beat_local_scores(scores, lag_curve);
    let max_local = local_scores.iter().copied().fold(0.0_f32, f32::max);
    if max_local <= 0.0 {
        return Vec::new();
    }

    let mut cumulative = vec![0.0_f32; scores.len()];
    let mut backlink = vec![usize::MAX; scores.len()];
    let first_threshold = max_local * 0.02;
    let mut first_beat_found = false;

    for index in 0..scores.len() {
        let target = lag_curve[index].max(2);
        let min_distance = (target / 2).max(2);
        let max_distance = target.saturating_mul(2);
        let mut best_score = f32::NEG_INFINITY;
        let mut best_predecessor = usize::MAX;

        let first_predecessor = index.saturating_sub(max_distance);
        let last_predecessor = index.saturating_sub(min_distance);
        if index >= min_distance {
            for predecessor in first_predecessor..=last_predecessor {
                let distance = index.saturating_sub(predecessor);
                if distance < min_distance || distance > max_distance {
                    continue;
                }
                let timing_error = (distance as f32 / target as f32).ln();
                // A two-beat jump is a valid recovery when an attack is
                // genuinely missing, but it should cost enough that a
                // supported half-time path cannot win by default. The
                // logarithmic term still allows gradual tempo drift.
                let skipped_beats = ((distance as f32 / target as f32) - 1.0).max(0.0);
                let transition_penalty = 18.0 * timing_error * timing_error + 3.0 * skipped_beats;
                let candidate = cumulative[predecessor] - transition_penalty;
                if candidate > best_score {
                    best_score = candidate;
                    best_predecessor = predecessor;
                }
            }
        }

        cumulative[index] = if best_predecessor == usize::MAX {
            local_scores[index]
        } else {
            local_scores[index] + best_score
        };

        if !first_beat_found && local_scores[index] < first_threshold {
            backlink[index] = usize::MAX;
        } else {
            backlink[index] = best_predecessor;
            first_beat_found = true;
        }
    }

    let mut local_maxima = Vec::new();
    for index in 1..scores.len().saturating_sub(1) {
        if cumulative[index] >= cumulative[index - 1] && cumulative[index] > cumulative[index + 1] {
            local_maxima.push(index);
        }
    }
    if local_maxima.is_empty() {
        return Vec::new();
    }

    let mut maxima_scores = local_maxima
        .iter()
        .map(|index| cumulative[*index])
        .collect::<Vec<_>>();
    maxima_scores.sort_by(|a, b| a.total_cmp(b));
    let tail_threshold = percentile_sorted(&maxima_scores, 0.50) * 0.50;
    let tail = local_maxima
        .into_iter()
        .rev()
        .find(|index| cumulative[*index] >= tail_threshold)
        .unwrap_or(scores.len() - 1);

    let mut path = Vec::new();
    let mut cursor = tail;
    loop {
        path.push(cursor);
        let previous = backlink[cursor];
        if previous == usize::MAX || previous >= cursor {
            break;
        }
        cursor = previous;
    }
    path.reverse();

    trim_weak_path_edges(&mut path, &local_scores);
    path
}

fn smoothed_beat_local_scores(scores: &[f32], lag_curve: &[usize]) -> Vec<f32> {
    let mean = scores.iter().copied().sum::<f32>() / scores.len().max(1) as f32;
    let variance = scores
        .iter()
        .map(|score| {
            let centered = *score - mean;
            centered * centered
        })
        .sum::<f32>()
        / scores.len().saturating_sub(1).max(1) as f32;
    let standard_deviation = variance.sqrt().max(1.0e-6);
    let normalized = scores
        .iter()
        .map(|score| (*score / standard_deviation).max(0.0))
        .collect::<Vec<_>>();

    let mut local = vec![0.0_f32; scores.len()];
    for index in 0..scores.len() {
        let lag = lag_curve[index].max(2);
        let radius = (lag / 3).max(2);
        let sigma = (lag as f32 / 16.0).max(1.0);
        let lo = index.saturating_sub(radius);
        let hi = (index + radius + 1).min(scores.len());
        let mut weighted = 0.0_f32;
        let mut weight_sum = 0.0_f32;

        for (offset, value) in normalized[lo..hi].iter().enumerate() {
            let source = lo + offset;
            let distance = source as f32 - index as f32;
            let weight = (-0.5 * (distance / sigma).powi(2)).exp();
            weighted += *value * weight;
            weight_sum += weight;
        }
        local[index] = weighted / weight_sum.max(1.0e-6);
    }

    local
}

fn trim_weak_path_edges(path: &mut Vec<usize>, local_scores: &[f32]) {
    if path.len() < 3 {
        return;
    }

    let mut beat_scores = path
        .iter()
        .filter_map(|index| local_scores.get(*index).copied())
        .collect::<Vec<_>>();
    beat_scores.sort_by(|a, b| a.total_cmp(b));
    let threshold = percentile_sorted(&beat_scores, 0.50) * 0.22;

    while path.len() > 2
        && path
            .first()
            .and_then(|index| local_scores.get(*index))
            .copied()
            .unwrap_or(0.0)
            < threshold
    {
        path.remove(0);
    }
    while path.len() > 2
        && path
            .last()
            .and_then(|index| local_scores.get(*index))
            .copied()
            .unwrap_or(0.0)
            < threshold
    {
        path.pop();
    }
}

fn calibrate_beat_grid_scores(beats: &mut [(f64, f32)]) {
    if beats.is_empty() {
        return;
    }

    if beats.len() == 1 {
        beats[0].1 = 0.97;
        return;
    }

    let mut ranked_indices = (0..beats.len()).collect::<Vec<_>>();
    ranked_indices.sort_by(|a, b| beats[*a].1.total_cmp(&beats[*b].1));

    for (rank, index) in ranked_indices.into_iter().enumerate() {
        let percentile = rank as f32 / (beats.len() - 1) as f32;
        // Rank calibration gives the UI slider a predictable curve:
        // low sensitivity keeps almost everything, high sensitivity keeps only
        // the strongest musical beats. Raw detector strength still decides
        // ordering; the slider no longer depends on accidental score clustering.
        beats[index].1 = (0.22 + percentile * 0.75).clamp(0.20, 0.97);
    }
}

fn estimate_beat_lag(norm: &[f32], frame_step: f64) -> Option<usize> {
    if norm.len() < 24 || frame_step <= 0.0 {
        return None;
    }

    let min_lag = ((60.0 / 190.0) / frame_step).round().max(2.0) as usize;
    let max_lag = ((60.0 / 58.0) / frame_step)
        .round()
        .min((norm.len() / 2) as f64) as usize;
    if min_lag >= max_lag {
        return None;
    }

    let mut best_lag = 0;
    let mut best_score = 0.0_f32;
    for lag in min_lag..=max_lag {
        let bpm = 60.0 / (lag as f64 * frame_step);
        let mut cross = 0.0_f32;
        let mut left_energy = 0.0_f32;
        let mut right_energy = 0.0_f32;
        for i in lag..norm.len() {
            let a = norm[i].max(0.0);
            let b = norm[i - lag].max(0.0);
            if a < 0.05 && b < 0.05 {
                continue;
            }
            cross += a * b;
            left_energy += a * a;
            right_energy += b * b;
        }
        let corr = cross / (left_energy.sqrt() * right_energy.sqrt()).max(1.0e-6);
        let tempo_prior = if (75.0..=165.0).contains(&bpm) {
            1.0
        } else if (60.0..=185.0).contains(&bpm) {
            0.94
        } else {
            0.85
        };
        let score = corr * tempo_prior;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    (best_lag > 0 && best_score >= 0.10).then_some(best_lag)
}

fn estimate_beat_phase(norm: &[f32], lag: usize) -> Option<usize> {
    if lag == 0 || norm.len() < lag * 2 {
        return None;
    }

    let mut best_phase = 0;
    let mut best_score = 0.0_f32;
    for phase in 0..lag {
        let mut score = 0.0_f32;
        let mut count = 0;
        let mut index = phase;
        while index < norm.len() {
            let lo = index.saturating_sub(2);
            let hi = (index + 2).min(norm.len() - 1);
            let local = norm[lo..=hi].iter().copied().fold(0.0_f32, f32::max);
            score += local;
            count += 1;
            index += lag;
        }
        if count > 0 {
            score /= count as f32;
        }
        if score > best_score {
            best_score = score;
            best_phase = phase;
        }
    }

    (best_score >= 0.06).then_some(best_phase)
}

fn best_local_grid_onset(scores: &[f32], center: usize, radius: usize) -> Option<(usize, f32)> {
    if scores.is_empty() || center >= scores.len() {
        return None;
    }

    let lo = center.saturating_sub(radius);
    let hi = (center + radius).min(scores.len() - 1);
    let mut best_index = center;
    let mut best_score = 0.0_f32;
    for (offset, score) in scores[lo..=hi].iter().enumerate() {
        if *score > best_score {
            best_score = *score;
            best_index = lo + offset;
        }
    }

    (best_score > 0.0).then_some((best_index, best_score))
}

fn add_drop_rise_candidates(ctx: DropRiseCandidateContext<'_>, beats: &mut Vec<(f64, f32)>) {
    let frames = ctx.frames;
    let drop_rise_scores = ctx.drop_rise_scores;
    let stable_scores = ctx.stable_scores;
    if frames.is_empty() || drop_rise_scores.is_empty() || stable_scores.is_empty() {
        return;
    }

    let threshold = robust_percentile(drop_rise_scores, 0.94).max(0.28);
    let mut candidates = drop_rise_scores
        .iter()
        .enumerate()
        .filter_map(|(index, score)| {
            if *score < threshold || index >= frames.len() || index >= stable_scores.len() {
                return None;
            }
            if !has_direct_onset_evidence(frames, index, ctx.lag.clamp(4, 32)) {
                return None;
            }
            let stable = stable_scores[index].max(ctx.min_score * 0.90);
            Some((index, (*score + stable).max(stable)))
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    let max_candidates = (frames.len() / 180).clamp(1, 4);
    for (index, score) in candidates.into_iter().take(max_candidates) {
        let snapped = snap_event_time(ctx.samples, ctx.sample_rate, frames[index].time);
        beats.push((snapped, score));
    }
}

fn reinforce_rhythmic_scores(frames: &[FrameEnergy], scores: &[f32]) -> Vec<f32> {
    if frames.len() < 24 || scores.len() < 24 {
        return scores.to_vec();
    }

    let frame_step = median_frame_step_seconds(frames);
    if frame_step <= 0.0 {
        return scores.to_vec();
    }

    let min_lag = ((0.240 / frame_step).round() as usize).max(2);
    let max_lag = ((0.950 / frame_step).round() as usize).min(scores.len() / 2);
    if min_lag >= max_lag {
        return scores.to_vec();
    }

    let norm = normalize_series(scores, 0.985);
    let mut best_lag = 0;
    let mut best_corr = 0.0_f32;

    for lag in min_lag..=max_lag {
        let mut cross = 0.0_f32;
        let mut left_energy = 0.0_f32;
        let mut right_energy = 0.0_f32;
        for i in lag..norm.len() {
            let a = norm[i].max(0.0);
            let b = norm[i - lag].max(0.0);
            if a < 0.04 && b < 0.04 {
                continue;
            }
            cross += a * b;
            left_energy += a * a;
            right_energy += b * b;
        }
        let corr = cross / (left_energy.sqrt() * right_energy.sqrt()).max(1.0e-6);
        if corr > best_corr {
            best_corr = corr;
            best_lag = lag;
        }
    }

    if best_lag == 0 || best_corr < 0.090 {
        return scores.to_vec();
    }

    let boost_limit = 0.34;
    let confidence = ((best_corr - 0.09) / 0.24).clamp(0.0, 1.0);

    scores
        .iter()
        .enumerate()
        .map(|(i, score)| {
            let support = rhythmic_neighbor_support(&norm, i, best_lag);
            let boost = 1.0 + support * confidence * boost_limit;
            score * boost
        })
        .collect()
}

fn median_frame_step_seconds(frames: &[FrameEnergy]) -> f64 {
    if frames.len() < 2 {
        return 0.0;
    }
    let mut steps = frames
        .windows(2)
        .filter_map(|pair| {
            let step = pair[1].time - pair[0].time;
            (step > 0.0 && step.is_finite()).then_some(step)
        })
        .collect::<Vec<_>>();
    if steps.is_empty() {
        return 0.0;
    }
    steps.sort_by(|a, b| a.total_cmp(b));
    steps[steps.len() / 2]
}

fn rhythmic_neighbor_support(norm: &[f32], index: usize, lag: usize) -> f32 {
    let mut support = 0.0_f32;
    for multiple in 1..=2 {
        let weight = if multiple == 1 { 1.0 } else { 0.62 };
        let offset = lag * multiple;
        if index >= offset {
            support = support.max(norm[index - offset] * weight);
        }
        if index + offset < norm.len() {
            support = support.max(norm[index + offset] * weight);
        }
    }
    support.clamp(0.0, 1.0)
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

fn has_direct_onset_evidence(frames: &[FrameEnergy], index: usize, prior_frames: usize) -> bool {
    if frames.is_empty() || index >= frames.len() {
        return false;
    }

    let prior_start = index.saturating_sub(prior_frames);
    let prior = frame_medians(frames, prior_start, index);
    let frame = frames[index];

    let bass_entry = positive_rise(frame.bass, prior.bass);
    let body_entry = positive_rise(frame.body, prior.body);
    let attack_entry = positive_rise(frame.attack, prior.attack);
    let presence_entry = positive_rise(frame.presence, prior.presence);
    let wide_entry = positive_rise(frame.wide, prior.wide);
    let rms_entry = positive_rise(frame.rms, prior.rms);
    let peak_entry = positive_rise(frame.peak, prior.peak);

    let percussion = bass_entry * 0.36 + body_entry * 0.30 + attack_entry * 0.28;
    let melodic = presence_entry * 0.42 + wide_entry * 0.20;
    let envelope = rms_entry * 0.62 + peak_entry * 0.38;

    (percussion >= 0.16 && envelope >= 0.050)
        || (percussion >= 0.12 && attack_entry >= 0.18 && peak_entry >= 0.050)
        || (percussion + melodic * 0.35 >= 0.30 && wide_entry >= 0.065)
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

fn snap_event_time(samples: &[f32], sample_rate: u32, estimated_time: f64) -> f64 {
    if samples.is_empty() || sample_rate == 0 {
        return estimated_time.max(0.0);
    }

    let sr = sample_rate as f64;
    let estimated = (estimated_time * sr).round() as isize;
    let look_back = 0.055;
    let look_forward = 0.090;
    let start = (estimated - (look_back * sr) as isize).max(1) as usize;
    let end = (estimated + (look_forward * sr) as isize)
        .max(start as isize + 1)
        .min(samples.len().saturating_sub(1) as isize) as usize;

    if start >= end {
        return estimated_time.max(0.0);
    }

    let local_mean = local_abs_mean(samples, start, end).max(1.0e-6);
    let pre_window = (0.016 * sr) as usize;
    let post_window = (0.012 * sr) as usize;
    let mut best_index = start;
    let mut best_score = 0.0_f32;
    let mut onset_scores = Vec::with_capacity(end.saturating_sub(start) + 1);
    for i in start..=end {
        let pre_start = i
            .saturating_sub(pre_window)
            .max(start.saturating_sub(pre_window));
        let pre_end = i.saturating_sub(1);
        let post_end = (i + post_window).min(samples.len() - 1);
        let pre = mean_abs_range(samples, pre_start, pre_end).max(local_mean * 0.18);
        let post = mean_abs_range(samples, i, post_end);
        let envelope_rise = ((post - pre) / pre.max(1.0e-6)).max(0.0);
        let diff = (samples[i] - samples[i - 1]).abs();
        let amp = samples[i].abs();
        let impulse = (diff * 0.70 + amp * 0.30) / local_mean;
        let score = envelope_rise * 0.82 + impulse * 0.18;
        onset_scores.push((i, score, envelope_rise, impulse));
        if score > best_score {
            best_score = score;
            best_index = i;
        }
    }

    if best_score <= 0.42 {
        return estimated_time.max(0.0);
    }

    let early_ratio = 0.36;
    for (index, score, envelope_rise, impulse) in onset_scores {
        if index > best_index {
            break;
        }
        if score >= best_score * early_ratio && (envelope_rise >= 0.22 || impulse >= 2.4) {
            best_index = index;
            break;
        }
    }

    let pre_roll = 0.008;
    ((best_index as f64 / sr) - pre_roll).max(0.0)
}

fn mean_abs_range(samples: &[f32], start: usize, end: usize) -> f32 {
    if samples.is_empty() || start >= samples.len() || start > end {
        return 0.0;
    }
    let end = end.min(samples.len() - 1);
    let mut sum = 0.0;
    let mut count = 0;
    for sample in &samples[start..=end] {
        sum += sample.abs();
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
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

fn percentile_sorted(sorted: &[f32], percentile: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f32 * percentile.clamp(0.0, 1.0)).round() as usize;
    sorted[index]
}

fn median_absolute_deviation_sorted(sorted: &[f32], median: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let mut deviations = sorted
        .iter()
        .map(|value| (*value - median).abs())
        .collect::<Vec<_>>();
    deviations.sort_by(|a, b| a.total_cmp(b));
    deviations[deviations.len() / 2]
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
    fn parses_clip_range_args_before_media_path() {
        let options = parse_args_from(vec![
            "--start".to_string(),
            "42.5".to_string(),
            "--duration".to_string(),
            "12.25".to_string(),
            "C:\\Media Files\\song cut.mp4".to_string(),
        ])
        .expect("clip-range args should parse");

        assert_eq!(options.media_path, "C:\\Media Files\\song cut.mp4");
        assert_eq!(options.start_seconds, Some(42.5));
        assert_eq!(options.duration_seconds, Some(12.25));
    }

    fn write_wav_file(
        path: &Path,
        samples: &[i16],
        sample_rate: u32,
    ) -> Result<(), std::io::Error> {
        use std::io::Write;
        let mut file = File::create(path)?;
        let data_size = (samples.len() * 2) as u32;
        let file_size = 36 + data_size;

        file.write_all(b"RIFF")?;
        file.write_all(&file_size.to_le_bytes())?;
        file.write_all(b"WAVE")?;
        file.write_all(b"fmt ")?;
        file.write_all(&16_u32.to_le_bytes())?;
        file.write_all(&1_u16.to_le_bytes())?;
        file.write_all(&1_u16.to_le_bytes())?;
        file.write_all(&sample_rate.to_le_bytes())?;
        file.write_all(&(sample_rate * 2).to_le_bytes())?;
        file.write_all(&2_u16.to_le_bytes())?;
        file.write_all(&16_u16.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_size.to_le_bytes())?;

        for &sample in samples {
            file.write_all(&sample.to_le_bytes())?;
        }
        Ok(())
    }

    #[test]
    fn analysis_range_trims_samples_and_reports_source_offset() {
        let sample_rate = 100;
        let samples = (0..1000).map(|val| val as i16).collect::<Vec<_>>();
        let temp_path = std::env::temp_dir().join("test_seek_trim_1.wav");
        write_wav_file(&temp_path, &samples, sample_rate).expect("failed to write temp WAV file");

        let (decoded, decoded_rate, offset) =
            decode_mono_audio(temp_path.to_str().unwrap(), Some(2.0), Some(3.0))
                .expect("decoding seek range should succeed");

        let _ = std::fs::remove_file(temp_path);

        assert_eq!(decoded_rate, sample_rate);
        assert_eq!(decoded.len(), 300);

        // i16 value converted to f32 sample by Symphonia
        let expected_first_sample = 200.0 / 32768.0;
        assert!((decoded[0] - expected_first_sample).abs() < 1.0e-3);
        assert!((offset - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn analysis_range_rejects_empty_selected_clip() {
        let sample_rate = 100;
        let samples = (0..1000).map(|val| val as i16).collect::<Vec<_>>();
        let temp_path = std::env::temp_dir().join("test_seek_trim_2.wav");
        write_wav_file(&temp_path, &samples, sample_rate).expect("failed to write temp WAV file");

        let result = decode_mono_audio(temp_path.to_str().unwrap(), Some(12.0), Some(1.0));

        let _ = std::fs::remove_file(temp_path);

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("selected clip range") || error.contains("no decodable"),
            "unexpected error message: {error}"
        );
    }

    #[test]
    fn chooses_nearest_analysis_window_at_common_video_rates() {
        assert_eq!(analysis_window_size(44_100), 2048);
        assert_eq!(analysis_window_size(48_000), 2048);
    }

    #[test]
    fn detects_dense_dhol_like_beat_grid() {
        let sample_rate = 48_000;
        let expected = [0.50, 1.00, 1.50, 2.00, 2.50];
        let mut samples = synthetic_ambient(sample_rate, 3.5);
        add_dhol_hits(&mut samples, sample_rate, &expected);
        let events = detect_events(&samples, sample_rate);
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
    fn keeps_soft_dhol_beats_between_stronger_hits() {
        let sample_rate = 48_000;
        let expected = [0.50, 1.00, 1.50, 2.00, 2.50, 3.00];
        let mut samples = synthetic_ambient(sample_rate, 4.0);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[0.50, 1.50, 2.50], 1.55);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[1.00, 2.00, 3.00], 0.62);

        let events = detect_events(&samples, sample_rate);
        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.080)
            })
            .count();

        assert!(
            matched >= 5,
            "expected rhythmic support to keep at least 5/6 hits, matched {matched}; events: {events:?}"
        );
    }

    #[test]
    fn keeps_late_soft_beats_after_loud_intro() {
        let sample_rate = 48_000;
        let mut samples = synthetic_ambient(sample_rate, 64.0);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[1.0, 1.5, 2.0, 2.5], 1.9);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[52.0, 52.5, 53.0, 53.5], 0.58);

        let events = detect_events(&samples, sample_rate);
        let late_matches = [52.0, 52.5, 53.0, 53.5]
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.095)
            })
            .count();

        assert!(
            late_matches >= 3,
            "expected consistent late-track sensitivity, matched {late_matches}/4; events: {events:?}"
        );
    }

    #[test]
    fn follows_a_gradual_tempo_change() {
        let sample_rate = 48_000;
        let mut expected = Vec::new();
        let mut time = 0.80_f64;
        for beat in 0..22 {
            expected.push(time);
            let progress = beat as f64 / 21.0;
            let period = 0.56 * (1.0 - progress) + 0.41 * progress;
            time += period;
        }

        let mut samples = synthetic_ambient(sample_rate, time + 0.8);
        add_dhol_hits_scaled(&mut samples, sample_rate, &expected, 1.25);
        let events = detect_events(&samples, sample_rate);
        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.080)
            })
            .count();

        assert!(
            matched >= 18,
            "expected local tempo tracking to follow at least 18/22 ramped beats, matched {matched}; events: {events:?}"
        );
    }

    #[test]
    fn tracks_distinct_tempo_sections() {
        let sample_rate = 48_000;
        let first = [0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25];
        let second = [
            8.00, 8.333, 8.666, 8.999, 9.332, 9.665, 9.998, 10.331, 10.664, 10.997,
        ];
        let mut samples = synthetic_ambient_scaled(sample_rate, 12.0, 0.30);
        add_dhol_hits_scaled(&mut samples, sample_rate, &first, 1.45);
        add_dhol_hits_scaled(&mut samples, sample_rate, &second, 1.30);

        let events = detect_events(&samples, sample_rate);
        let first_matches = first
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.080)
            })
            .count();
        let second_matches = second
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.080)
            })
            .count();

        assert!(
            first_matches >= 7 && second_matches >= 8,
            "expected both tempo sections to survive, matched {first_matches}/8 and {second_matches}/10; events: {events:?}"
        );
    }

    #[test]
    fn resolves_a_supported_subdivision_instead_of_half_time() {
        let sample_rate = 48_000;
        let expected = (1..=12)
            .map(|index| index as f64 * 0.50)
            .collect::<Vec<_>>();
        let strong = (2..=12)
            .step_by(2)
            .map(|index| index as f64 * 0.50)
            .collect::<Vec<_>>();
        let mut samples = synthetic_ambient_scaled(sample_rate, 7.0, 0.28);
        add_dhol_hits_scaled(&mut samples, sample_rate, &strong, 1.55);
        add_dhol_hits_scaled(&mut samples, sample_rate, &expected, 0.58);

        let events = detect_events(&samples, sample_rate);
        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.080)
            })
            .count();

        assert!(
            matched >= 9,
            "expected a supported half-second subdivision to survive, matched {matched}/{}; events: {events:?}",
            expected.len()
        );
    }

    #[test]
    fn keeps_only_locally_prominent_major_hits() {
        let events = (0..120)
            .map(|index| Event {
                time: index as f64 * 0.50,
                score: if index % 9 == 0 {
                    1.0
                } else if index % 5 == 0 {
                    0.70
                } else {
                    0.25
                },
            })
            .collect::<Vec<_>>();

        let major_hits = select_major_hit_markers(events);

        assert!(
            !major_hits.is_empty() && major_hits.len() < 40,
            "expected a small, song-driven set of major hits, got {major_hits:?}"
        );
        assert!(
            major_hits.iter().all(|event| event.score >= 0.70),
            "weak background beats should not survive major-hit selection: {major_hits:?}"
        );
    }

    #[test]
    fn filters_a_weak_sparse_outlier_from_major_hits() {
        let events = vec![
            Event {
                time: 0.0,
                score: 0.90,
            },
            Event {
                time: 4.0,
                score: 0.88,
            },
            Event {
                time: 8.0,
                score: 0.92,
            },
            Event {
                time: 12.0,
                score: 0.25,
            },
            Event {
                time: 16.0,
                score: 0.89,
            },
        ];

        let major_hits = select_major_hit_markers(events);

        assert!(
            major_hits.iter().all(|event| event.time != 12.0),
            "isolated low-confidence candidate should not become a marker: {major_hits:?}"
        );
    }

    #[test]
    fn bridges_an_implied_beat_inside_an_active_rhythm() {
        let sample_rate = 48_000;
        let audible = [0.75, 1.25, 1.75, 2.75, 3.25, 3.75];
        let implied = 2.25;
        let mut samples = synthetic_ambient(sample_rate, 4.6);
        add_dhol_hits_scaled(&mut samples, sample_rate, &audible, 1.30);

        let events = detect_events(&samples, sample_rate);
        assert!(
            events
                .iter()
                .any(|event| (event.time - implied).abs() <= 0.090),
            "expected the rhythmic decoder to preserve the implied beat at {implied}; events: {events:?}"
        );
    }

    #[test]
    fn does_not_fill_quiet_gap_with_false_beats() {
        let sample_rate = 48_000;
        let mut samples = synthetic_ambient_scaled(sample_rate, 24.0, 0.28);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[2.0, 2.5, 3.0], 1.7);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[18.0, 18.5, 19.0], 1.4);

        let events = detect_events(&samples, sample_rate);
        let quiet_gap_events = events
            .iter()
            .filter(|event| event.time >= 7.0 && event.time <= 15.0)
            .count();

        assert_eq!(
            quiet_gap_events, 0,
            "quiet/no-onset section should be skipped; events: {events:?}"
        );
    }

    #[test]
    fn returns_consistent_beat_grid_without_mode_overlap_noise() {
        let sample_rate = 48_000;
        let expected = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
        let mut samples = synthetic_ambient(sample_rate, 5.0);
        add_dhol_hits_scaled(&mut samples, sample_rate, &expected, 1.25);

        let events = detect_events(&samples, sample_rate);
        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.095)
            })
            .count();

        assert!(
            matched >= 5,
            "expected beat-grid mode to follow the main pulse, matched {matched}/6; events: {events:?}"
        );
    }

    #[test]
    fn beat_timing_snaps_to_repeated_attacks_before_louder_resonance() {
        let sample_rate = 48_000;
        let expected = [1.00, 1.50, 2.00, 2.50];
        let mut samples = synthetic_ambient(sample_rate, 3.5);
        for time in expected {
            add_attack_then_resonance(&mut samples, sample_rate, time);
        }

        let events = detect_events(&samples, sample_rate);
        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.055)
            })
            .count();
        assert!(
            matched >= 3,
            "expected attack-aligned beat markers, matched {matched}/4; events: {events:?}"
        );
    }

    #[test]
    fn promotes_dhol_rise_after_energy_drop() {
        let sample_rate = 48_000;
        let mut samples = synthetic_ambient_scaled(sample_rate, 8.0, 0.22);
        add_energy_pad(&mut samples, sample_rate, 0.7, 2.8, 0.52);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[0.8, 1.3, 1.8, 2.3], 1.35);
        add_dhol_hits_scaled(&mut samples, sample_rate, &[5.45, 5.95, 6.45], 1.45);

        let frames = band_energies(&samples, sample_rate);
        let drop_rise = drop_rise_transition_scores(&frames);
        let rise_frame = frames
            .iter()
            .position(|frame| frame.time >= 5.35)
            .expect("rise frame should exist");
        let rise_score = drop_rise[rise_frame..(rise_frame + 70).min(drop_rise.len())]
            .iter()
            .copied()
            .fold(0.0_f32, f32::max);
        let max_score = drop_rise.iter().copied().fold(0.0_f32, f32::max);
        let max_index = drop_rise
            .iter()
            .position(|score| (*score - max_score).abs() < f32::EPSILON)
            .unwrap_or(0);
        assert!(
            rise_score >= 0.28,
            "expected drop/rise detector to promote the re-entry, score {rise_score}, max {max_score} at {}",
            frames[max_index].time
        );

        let events = detect_events(&samples, sample_rate);
        assert!(
            events
                .iter()
                .any(|event| (event.time >= 5.40) && (event.time <= 6.08)),
            "expected marker in the dhol rise zone after quiet breakdown; events: {events:?}"
        );
    }

    fn synthetic_ambient(sample_rate: u32, duration_seconds: f64) -> Vec<f32> {
        synthetic_ambient_scaled(sample_rate, duration_seconds, 1.0)
    }

    fn synthetic_ambient_scaled(sample_rate: u32, duration_seconds: f64, gain: f32) -> Vec<f32> {
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
            samples.push((hum + noise) * gain);
        }
        samples
    }

    fn add_dhol_hits(samples: &mut [f32], sample_rate: u32, times: &[f64]) {
        add_dhol_hits_scaled(samples, sample_rate, times, 1.8);
    }

    fn add_dhol_hits_scaled(samples: &mut [f32], sample_rate: u32, times: &[f64], gain: f32) {
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
                samples[index] += (low * 0.85 + body * 0.40 + attack_noise * 0.30) * gain;
            }
        }
    }

    fn add_energy_pad(
        samples: &mut [f32],
        sample_rate: u32,
        start_seconds: f64,
        end_seconds: f64,
        gain: f32,
    ) {
        let start = (start_seconds * sample_rate as f64).round() as usize;
        let end = (end_seconds * sample_rate as f64).round() as usize;
        for index in start..end.min(samples.len()) {
            let t = index as f32 / sample_rate as f32;
            let pad = (std::f32::consts::TAU * 95.0 * t).sin() * 0.35
                + (std::f32::consts::TAU * 240.0 * t).sin() * 0.22
                + (std::f32::consts::TAU * 1400.0 * t).sin() * 0.08;
            samples[index] += pad * gain;
        }
    }

    fn add_attack_then_resonance(samples: &mut [f32], sample_rate: u32, time: f64) {
        let start = (time * sample_rate as f64).round() as usize;
        let attack_len = (0.018 * sample_rate as f64).round() as usize;
        for offset in 0..attack_len {
            let index = start + offset;
            if index >= samples.len() {
                break;
            }
            let t = offset as f32 / sample_rate as f32;
            let tick = (((offset * 53) % 47) as f32 / 23.5 - 1.0) * (-t * 95.0).exp();
            samples[index] += tick * 0.45;
        }

        let resonance_start = start + (0.045 * sample_rate as f64).round() as usize;
        let resonance_len = (0.130 * sample_rate as f64).round() as usize;
        for offset in 0..resonance_len {
            let index = resonance_start + offset;
            if index >= samples.len() {
                break;
            }
            let t = offset as f32 / sample_rate as f32;
            let body = (std::f32::consts::TAU * 92.0 * t).sin() * (-t * 16.0).exp()
                + (std::f32::consts::TAU * 360.0 * t).sin() * (-t * 24.0).exp() * 0.50;
            samples[index] += body * 1.95;
        }
    }
}
