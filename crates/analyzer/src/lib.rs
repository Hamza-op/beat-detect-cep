mod cli;
pub mod model;

use cli::{parse_args, usage};
use model::Event;

use std::error::Error;
use std::fs::File;
use std::io::{self, BufWriter, Write};
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
use symphonia::core::units::{Time, TimeBase};
use symphonia::default::{get_codecs, get_probe};

/*
 * Input/output contracts:
 *
 * - JSON event arrays are written only to stdout.
 * - Diagnostics and warnings belong on stderr.
 * - Event times are source-media seconds, not clip-relative seconds.
 * - Selected ranges are half-open: [start, start + duration).
 * - No resampling or channel-layout-specific downmixing is performed.
 * - Channels are averaged equally. Opposite-phase channels can cancel.
 *
 * Decoder safety:
 *
 * - Decode errors, format resets, and sample-rate changes fail explicitly.
 *   Silently skipping them would shift subsequent event timing.
 * - Small timestamp quantization discrepancies are tolerated.
 * - Genuine timestamp discontinuities fail rather than compressing time.
 * - Accurate seek is attempted, but a failed seek causes a fresh sequential
 *   decode. A potentially altered demuxer is never reused after seek failure.
 *
 * DSP:
 *
 * - FFT plans, input buffers, and scratch storage are reused.
 * - Frequency-band membership is precomputed once per analysis.
 * - Scores are relative musical salience, not calibrated probabilities.
 * - Beat tracking can bridge implied beats within active rhythmic sections.
 * - This implementation still requires validation against representative
 *   music, codecs, container timestamps, and the bundled Symphonia version.
 */

const LOG_BANDS: usize = 40;
const MIN_ANALYSIS_HZ: f32 = 45.0;
const MAX_ANALYSIS_HZ: f32 = 10_000.0;

const MIN_BEAT_BPM: f64 = 55.0;
const MAX_BEAT_BPM: f64 = 210.0;

const MAX_SAMPLE_RATE: u32 = 768_000;
const MAX_CHANNELS: usize = 64;
const MAX_ANALYSIS_SAMPLES: usize = 128 * 1024 * 1024;
const MAX_ANALYSIS_FRAMES: usize = 500_000;

const EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy)]
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

impl Default for FrameEnergy {
    fn default() -> Self {
        Self {
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
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct AnalysisRange {
    start_seconds: f64,
    end_seconds: Option<f64>,
}

impl AnalysisRange {
    fn new(
        start_seconds: Option<f64>,
        duration_seconds: Option<f64>,
    ) -> Result<Self, Box<dyn Error>> {
        let start = start_seconds.unwrap_or(0.0);

        if !start.is_finite() || start < 0.0 {
            return Err("selected clip start must be finite and >= 0".into());
        }

        let end = match duration_seconds {
            Some(duration) => {
                if !duration.is_finite() || duration <= 0.0 {
                    return Err(
                        "selected clip duration must be finite and greater than zero".into(),
                    );
                }

                let end = start + duration;

                if !end.is_finite() || end <= start {
                    return Err("selected clip range cannot be represented safely".into());
                }

                Some(end)
            }
            None => None,
        };

        Ok(Self {
            start_seconds: start,
            end_seconds: end,
        })
    }
}

fn sample_index(seconds: f64, sample_rate: u32) -> Result<u64, Box<dyn Error>> {
    let value = seconds * f64::from(sample_rate);

    // f64 cannot exactly represent every integer beyond 2^53.
    const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;

    if !value.is_finite() || !(0.0..=MAX_EXACT_INTEGER).contains(&value) {
        return Err("audio timestamp exceeds the supported sample-index range".into());
    }

    Ok(value.round() as u64)
}

pub fn run() -> Result<(), Box<dyn Error>> {
    // Do not replace the process-wide panic hook from a reusable library.
    let options = parse_args()?;

    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());

    if options.help {
        writeln!(output, "{}", usage())?;
        output.flush()?;
        return Ok(());
    }

    if options.version {
        writeln!(output, "beat_analyzer {}", env!("CARGO_PKG_VERSION"))?;
        output.flush()?;
        return Ok(());
    }

    let range = AnalysisRange::new(options.start_seconds, options.duration_seconds)?;

    let (samples, sample_rate, offset) = decode_mono_audio(
        &options.media_path,
        options.start_seconds,
        options.duration_seconds,
    )?;

    let mut events = detect_events(&samples, sample_rate);

    for event in &mut events {
        // Preserve sub-millisecond precision until source offset is applied.
        event.time = round_time(event.time + offset);
        event.score = round_score(event.score);
    }

    events.retain(|event| {
        event.time.is_finite()
            && event.score.is_finite()
            && event.time >= range.start_seconds
            && range
                .end_seconds
                .map(|end| event.time < end)
                .unwrap_or(true)
    });

    events.sort_by(|a, b| {
        a.time
            .total_cmp(&b.time)
            .then_with(|| b.score.total_cmp(&a.score))
    });

    events.dedup_by(|later, earlier| (later.time - earlier.time).abs() < 1.0e-6);

    serde_json::to_writer(&mut output, &events)?;
    writeln!(output)?;
    output.flush()?;

    Ok(())
}

pub fn decode_mono_audio(
    media_path: &str,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
) -> Result<(Vec<f32>, u32, f64), Box<dyn Error>> {
    let range = AnalysisRange::new(start_seconds, duration_seconds)?;
    let path = Path::new(media_path);

    if !path.is_file() {
        return Err(format!("media path is not a regular file: {}", path.display()).into());
    }

    match decode_attempt(path, range, true)? {
        DecodeAttempt::Complete(result) => Ok(result),
        DecodeAttempt::RetrySequential => {
            eprintln!("[beat_analyzer] accurate seek unavailable; decoding sequentially");

            match decode_attempt(path, range, false)? {
                DecodeAttempt::Complete(result) => Ok(result),
                DecodeAttempt::RetrySequential => Err("unexpected sequential decoder retry".into()),
            }
        }
    }
}

enum DecodeAttempt {
    Complete((Vec<f32>, u32, f64)),
    RetrySequential,
}

fn decode_attempt(
    path: &Path,
    range: AnalysisRange,
    allow_seek: bool,
) -> Result<DecodeAttempt, Box<dyn Error>> {
    let file = File::open(path)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = get_probe().format(
        &hint,
        stream,
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
        .ok_or("no audio track with a declared sample rate was found")?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let sample_rate = codec_params
        .sample_rate
        .ok_or("audio track has no sample rate")?;

    if sample_rate == 0 || sample_rate > MAX_SAMPLE_RATE {
        return Err(format!("unsupported audio sample rate: {sample_rate}").into());
    }

    let time_base = codec_params
        .time_base
        .unwrap_or_else(|| TimeBase::new(1, sample_rate));

    let mut decoder = match get_codecs().make(&codec_params, &DecoderOptions::default()) {
        Ok(decoder) => decoder,
        Err(_) if codec_params.codec == CODEC_TYPE_OPUS => {
            return Err("Opus decoding is unavailable in this analyzer build. \
                 Convert the audio to a supported WAV, AAC, MP3, or M4A file."
                .into());
        }
        Err(error) => return Err(Box::new(error)),
    };

    let start_sample = sample_index(range.start_seconds, sample_rate)?;
    let end_sample = range
        .end_seconds
        .map(|seconds| sample_index(seconds, sample_rate))
        .transpose()?;

    if let Some(end) = end_sample {
        if end <= start_sample {
            return Err("selected clip range is shorter than one audio sample".into());
        }

        if end - start_sample > MAX_ANALYSIS_SAMPLES as u64 {
            return Err(
                "selected clip range exceeds the analyzer memory limit; analyze a shorter cut"
                    .into(),
            );
        }
    }

    let seek_requested = allow_seek && start_sample > 0;

    if seek_requested {
        if range.start_seconds >= u64::MAX as f64 {
            return Err("seek time exceeds the supported range".into());
        }

        let time = Time::new(
            range.start_seconds.floor() as u64,
            range.start_seconds.fract(),
        );

        if format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(track_id),
                },
            )
            .is_err()
        {
            return Ok(DecodeAttempt::RetrySequential);
        }

        decoder.reset();
    }

    let mut mono = Vec::<f32>::new();
    let mut packet_mono = Vec::<f32>::new();
    let mut previous_packet_end: Option<u64> = None;
    let mut first_output_sample: Option<u64> = None;
    let mut expected_channels: Option<usize> = None;
    let mut first_track_packet = true;

    // Allow one timestamp tick plus rounding, but never more than 5 ms.
    let tick = time_base.calc_time(1);
    let tick_seconds = tick.seconds as f64 + tick.frac;
    let timestamp_tolerance = ((tick_seconds * sample_rate as f64).ceil() as u64)
        .saturating_add(1)
        .min((sample_rate as f64 * 0.005).ceil() as u64)
        .max(1);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(
                    "audio format changed during decoding; transcode the selected media first"
                        .into(),
                );
            }
            Err(error) => return Err(Box::new(error)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let packet_time = time_base.calc_time(packet.ts());
        let packet_seconds = packet_time.seconds as f64 + packet_time.frac;
        let timestamp_start = sample_index(packet_seconds, sample_rate)?;

        if first_track_packet {
            first_track_packet = false;

            if seek_requested && timestamp_start > start_sample {
                // Seeking past the requested sample must not silently omit audio.
                return Ok(DecodeAttempt::RetrySequential);
            }
        }

        if end_sample
            .map(|end| timestamp_start >= end)
            .unwrap_or(false)
        {
            break;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(message)) => {
                return Err(format!(
                    "audio packet could not be decoded at {packet_seconds:.6}s: {message}; \
                     analysis stopped to avoid shifting marker timing"
                )
                .into());
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(
                    "audio decoder requires a stream reset; transcode the media first".into(),
                );
            }
            Err(error) => return Err(Box::new(error)),
        };

        if decoded.spec().rate != sample_rate {
            return Err("audio sample rate changed during decoding".into());
        }

        let channels = decoded.spec().channels.count();

        if channels == 0 || channels > MAX_CHANNELS {
            return Err(format!("unsupported audio channel count: {channels}").into());
        }

        if let Some(expected) = expected_channels {
            if channels != expected {
                return Err("audio channel count changed during decoding".into());
            }
        } else {
            expected_channels = Some(channels);
        }

        let frame_count = decoded.frames();

        if frame_count == 0 {
            continue;
        }

        if frame_count > MAX_ANALYSIS_SAMPLES {
            return Err("decoded audio packet exceeds the memory limit".into());
        }

        let packet_start = match previous_packet_end {
            Some(expected) if timestamp_start.abs_diff(expected) <= timestamp_tolerance => expected,
            Some(expected) => {
                return Err(format!(
                    "audio timestamp discontinuity: expected sample {expected}, \
                     received {timestamp_start}; analysis stopped to preserve timing"
                )
                .into());
            }
            None => timestamp_start,
        };

        let packet_end = packet_start
            .checked_add(frame_count as u64)
            .ok_or("decoded audio timestamp overflow")?;

        previous_packet_end = Some(packet_end);

        let selected_start = packet_start.max(start_sample);
        let selected_end = end_sample
            .map(|end| packet_end.min(end))
            .unwrap_or(packet_end);

        if selected_start >= selected_end {
            continue;
        }

        packet_mono.clear();
        packet_mono
            .try_reserve(frame_count)
            .map_err(|_| "unable to allocate decoded packet buffer")?;

        push_decoded_as_mono(decoded, &mut packet_mono);

        if packet_mono.len() != frame_count {
            return Err("decoder returned an inconsistent audio frame count".into());
        }

        let offset = usize::try_from(selected_start - packet_start)?;
        let length = usize::try_from(selected_end - selected_start)?;

        let new_length = mono
            .len()
            .checked_add(length)
            .ok_or("analysis buffer size overflow")?;

        if new_length > MAX_ANALYSIS_SAMPLES {
            return Err(
                "audio exceeds the analyzer memory limit; specify a shorter duration".into(),
            );
        }

        mono.try_reserve(length)
            .map_err(|_| "unable to allocate the audio analysis buffer")?;

        if first_output_sample.is_none() {
            first_output_sample = Some(selected_start);
        }

        mono.extend_from_slice(&packet_mono[offset..offset + length]);

        if end_sample.map(|end| packet_end >= end).unwrap_or(false) {
            break;
        }
    }

    let first =
        first_output_sample.ok_or("selected clip range contains no decodable audio samples")?;

    if mono.is_empty() {
        return Err("selected clip range contains no decodable audio samples".into());
    }

    Ok(DecodeAttempt::Complete((
        mono,
        sample_rate,
        first as f64 / sample_rate as f64,
    )))
}

fn push_decoded_as_mono(decoded: AudioBufferRef<'_>, output: &mut Vec<f32>) {
    macro_rules! append_buffer {
        ($buffer:expr) => {{
            let buffer = $buffer;
            push_planar_as_mono(
                buffer.spec().channels.count(),
                buffer.frames(),
                |channel, frame| f32::from_sample(buffer.chan(channel)[frame]),
                output,
            );
        }};
    }

    match decoded {
        AudioBufferRef::U8(buffer) => append_buffer!(buffer),
        AudioBufferRef::U16(buffer) => append_buffer!(buffer),
        AudioBufferRef::U24(buffer) => append_buffer!(buffer),
        AudioBufferRef::U32(buffer) => append_buffer!(buffer),
        AudioBufferRef::S8(buffer) => append_buffer!(buffer),
        AudioBufferRef::S16(buffer) => append_buffer!(buffer),
        AudioBufferRef::S24(buffer) => append_buffer!(buffer),
        AudioBufferRef::S32(buffer) => append_buffer!(buffer),
        AudioBufferRef::F32(buffer) => append_buffer!(buffer),
        AudioBufferRef::F64(buffer) => append_buffer!(buffer),
    }
}

fn push_planar_as_mono<F>(channels: usize, frames: usize, mut read: F, output: &mut Vec<f32>)
where
    F: FnMut(usize, usize) -> f32,
{
    if channels == 0 {
        return;
    }

    let gain = 1.0 / channels as f64;

    for frame in 0..frames {
        let mut sum = 0.0_f64;

        for channel in 0..channels {
            let sample = read(channel, frame);

            if sample.is_finite() {
                sum += sample as f64;
            }
        }

        output.push((sum * gain).clamp(-1.0, 1.0) as f32);
    }
}

pub fn detect_events(samples: &[f32], sample_rate: u32) -> Vec<Event> {
    if sample_rate == 0
        || sample_rate > MAX_SAMPLE_RATE
        || samples.is_empty()
        || samples.len() > MAX_ANALYSIS_SAMPLES
    {
        return Vec::new();
    }

    let window = analysis_window_size(sample_rate);
    let hop = analysis_hop_size(window);

    if samples.len() < window {
        return Vec::new();
    }

    let frame_count = 1 + (samples.len() - window) / hop;

    if !(8..=MAX_ANALYSIS_FRAMES).contains(&frame_count) {
        return Vec::new();
    }

    let frames = band_energies(samples, sample_rate);

    if frames.len() < 8 {
        return Vec::new();
    }

    let duration = samples.len() as f64 / sample_rate as f64;
    let mut events = detect_beat_grid_events(samples, sample_rate, &frames);

    events.retain(|event| {
        event.time.is_finite()
            && event.time >= 0.0
            && event.time < duration
            && event.score.is_finite()
    });

    events.sort_by(|a, b| a.time.total_cmp(&b.time));
    events
}

fn safe_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn analysis_window_size(sample_rate: u32) -> usize {
    let desired = (sample_rate as f64 * 0.046).round().clamp(1024.0, 4096.0) as usize;

    nearest_power_of_two(desired).clamp(1024, 4096)
}

fn analysis_hop_size(window: usize) -> usize {
    (window / 4).max(256)
}

fn nearest_power_of_two(value: usize) -> usize {
    if value <= 1 {
        return 1;
    }

    let Some(upper) = value.checked_next_power_of_two() else {
        return 1usize << (usize::BITS - 1);
    };

    let lower = upper / 2;

    if value - lower <= upper - value {
        lower
    } else {
        upper
    }
}

#[derive(Clone, Copy, Default)]
struct BinMembership {
    bass: bool,
    body: bool,
    attack: bool,
    presence: bool,
    wide: bool,
    log_band: Option<usize>,
    flux_weight: f32,
}

fn band_energies(samples: &[f32], sample_rate: u32) -> Vec<FrameEnergy> {
    if sample_rate == 0 {
        return Vec::new();
    }

    let window = analysis_window_size(sample_rate);
    let hop = analysis_hop_size(window);

    if samples.len() < window {
        return Vec::new();
    }

    let count = 1 + (samples.len() - window) / hop;

    if count > MAX_ANALYSIS_FRAMES {
        return Vec::new();
    }

    let hann = (0..window)
        .map(|index| {
            let phase = std::f64::consts::TAU * index as f64 / (window - 1) as f64;
            (0.5 - 0.5 * phase.cos()) as f32
        })
        .collect::<Vec<_>>();

    let half = window / 2;
    let bin_membership = (0..half)
        .map(|bin| {
            let frequency = bin as f32 * sample_rate as f32 / window as f32;

            BinMembership {
                bass: (45.0..180.0).contains(&frequency),
                body: (180.0..=950.0).contains(&frequency),
                attack: (1200.0..=8000.0).contains(&frequency),
                presence: (250.0..=4000.0).contains(&frequency),
                wide: (40.0..=10_000.0).contains(&frequency),
                log_band: log_band_index(frequency),
                flux_weight: 1.0 + bin as f32 / half as f32,
            }
        })
        .collect::<Vec<_>>();

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(window);

    let mut buffer = vec![Complex::new(0.0, 0.0); window];
    let mut scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut previous_magnitudes = vec![0.0_f32; half];
    let mut output = Vec::with_capacity(count);

    for frame_index in 0..count {
        let start = frame_index * hop;
        let mut sum_squares = 0.0_f64;
        let mut peak = 0.0_f32;

        for index in 0..window {
            let sample = safe_sample(samples[start + index]);

            buffer[index] = Complex::new(sample * hann[index], 0.0);
            sum_squares += sample as f64 * sample as f64;
            peak = peak.max(sample.abs());
        }

        fft.process_with_scratch(&mut buffer, &mut scratch);

        let mut powers = [0.0_f64; 5];
        let mut bins = [0usize; 5];
        let mut log_power = [0.0_f64; LOG_BANDS];
        let mut log_counts = [0usize; LOG_BANDS];
        let mut flux = 0.0_f64;

        for bin in 1..half {
            let membership = bin_membership[bin];
            let magnitude = buffer[bin].norm();
            let previous = previous_magnitudes[bin];

            // Avoid an artificial flux impulse at the beginning of the clip.
            if frame_index > 0 && membership.wide {
                flux += (magnitude - previous).max(0.0) as f64 * membership.flux_weight as f64;
            }

            previous_magnitudes[bin] = magnitude;

            let power = magnitude as f64 * magnitude as f64;
            let selected = [
                membership.bass,
                membership.body,
                membership.attack,
                membership.presence,
                membership.wide,
            ];

            for group in 0..selected.len() {
                if selected[group] {
                    powers[group] += power;
                    bins[group] += 1;
                }
            }

            if let Some(band) = membership.log_band {
                log_power[band] += power;
                log_counts[band] += 1;
            }
        }

        let mut log_bands = [0.0_f32; LOG_BANDS];

        for band in 0..LOG_BANDS {
            log_bands[band] = band_energy(log_power[band], log_counts[band]);
        }

        output.push(FrameEnergy {
            time: (start + window / 2) as f64 / sample_rate as f64,
            bass: band_energy(powers[0], bins[0]),
            body: band_energy(powers[1], bins[1]),
            attack: band_energy(powers[2], bins[2]),
            presence: band_energy(powers[3], bins[3]),
            wide: band_energy(powers[4], bins[4]),
            flux: energy_scale(flux / half as f64),
            // Keep mean-square energy for compatibility with existing tuning.
            rms: energy_scale(sum_squares / window as f64),
            peak: energy_scale(peak as f64),
            log_bands,
        });
    }

    output
}

fn band_energy(power: f64, bins: usize) -> f32 {
    if bins == 0 {
        0.0
    } else {
        energy_scale(power / bins as f64)
    }
}

fn energy_scale(value: f64) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.ln_1p() as f32
    } else {
        0.0
    }
}

fn log_band_index(frequency: f32) -> Option<usize> {
    if !(MIN_ANALYSIS_HZ..=MAX_ANALYSIS_HZ).contains(&frequency) {
        return None;
    }

    let position = (frequency / MIN_ANALYSIS_HZ).ln() / (MAX_ANALYSIS_HZ / MIN_ANALYSIS_HZ).ln();

    Some(((position * LOG_BANDS as f32) as usize).min(LOG_BANDS - 1))
}

fn log_band_center_hz(band: usize) -> f32 {
    let position = (band.min(LOG_BANDS - 1) as f32 + 0.5) / LOG_BANDS as f32;
    MIN_ANALYSIS_HZ * (MAX_ANALYSIS_HZ / MIN_ANALYSIS_HZ).powf(position)
}

fn positive_rise(current: f32, baseline: f32) -> f32 {
    if !current.is_finite() || !baseline.is_finite() || current <= baseline {
        return 0.0;
    }

    let floor = (current * 0.03).max(0.004);
    ((current - baseline) / baseline.max(floor)).clamp(0.0, 12.0)
}

fn dual_rate_ema(previous: f32, current: f32, up: f32, down: f32) -> f32 {
    previous + (current - previous) * if current > previous { up } else { down }
}

fn spectral_novelty_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    let Some(first) = frames.first() else {
        return Vec::new();
    };

    let mut baseline = [
        first.bass,
        first.body,
        first.attack,
        first.presence,
        first.wide,
        first.flux,
    ];

    let up = [0.015, 0.015, 0.020, 0.012, 0.010, 0.025];
    let down = [0.06, 0.06, 0.08, 0.05, 0.05, 0.10];
    let mut previous = baseline;
    let mut output = Vec::with_capacity(frames.len());

    for frame in frames {
        let current = [
            frame.bass,
            frame.body,
            frame.attack,
            frame.presence,
            frame.wide,
            frame.flux,
        ];

        let mut rise = [0.0_f32; 6];
        let mut snap = [0.0_f32; 6];

        for band in 0..6 {
            rise[band] = positive_rise(current[band], baseline[band]);
            snap[band] = positive_rise(current[band], previous[band]);
        }

        let percussion =
            rise[0] * 0.38 + rise[1] * 0.25 + rise[2] * 0.27 + rise[4] * 0.04 + rise[5] * 0.18;

        let transient =
            snap[0] * 0.30 + snap[1] * 0.20 + snap[2] * 0.32 + snap[4] * 0.06 + snap[5] * 0.26;

        let section = rise[4] * 0.32 + snap[4] * 0.16 + rise[0] * 0.10 + rise[5] * 0.25;

        let quiet = if percussion + transient < 0.18 {
            1.0
        } else {
            0.38
        };
        let midrange = rise[3] * (0.30 + 0.42 * quiet) + snap[3] * (0.14 + 0.18 * quiet);

        output.push(
            (percussion * 0.64 + transient * 0.66 + section * 0.32 + midrange * 0.16).max(0.0),
        );

        for band in 0..6 {
            baseline[band] = dual_rate_ema(baseline[band], current[band], up[band], down[band]);
        }

        previous = current;
    }

    output
}

fn envelope_onset_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    let Some(first) = frames.first() else {
        return Vec::new();
    };

    let mut rms_base = first.rms;
    let mut peak_base = first.peak;
    let mut previous = *first;
    let mut output = Vec::with_capacity(frames.len());

    for frame in frames {
        let score = positive_rise(frame.peak, peak_base) * 0.42
            + positive_rise(frame.peak, previous.peak) * 0.36
            + positive_rise(frame.rms, rms_base) * 0.38
            + positive_rise(frame.rms, previous.rms) * 0.18;

        output.push(score.max(0.0));

        rms_base = dual_rate_ema(rms_base, frame.rms, 0.015, 0.06);
        peak_base = dual_rate_ema(peak_base, frame.peak, 0.020, 0.08);
        previous = *frame;
    }

    output
}

fn gaussian_weight(frequency: f32, center: f32, width: f32) -> f32 {
    let distance = (frequency / center).log2() / width;
    (-0.5 * distance * distance).exp()
}

fn onset_band_weight(frequency: f32) -> f32 {
    0.18 + gaussian_weight(frequency, 90.0, 0.62) * 1.08
        + gaussian_weight(frequency, 430.0, 0.72) * 0.92
        + gaussian_weight(frequency, 2800.0, 0.95) * 0.82
        + gaussian_weight(frequency, 1100.0, 1.10) * 0.18
        + gaussian_weight(frequency, 4200.0, 1.00) * 0.22
}

fn previous_band_max(frames: &[FrameEnergy], index: usize, band: usize, lag: usize) -> f32 {
    if index < lag {
        return 0.0;
    }

    let first = band.saturating_sub(1);
    let last = (band + 1).min(LOG_BANDS - 1);

    frames[index - lag].log_bands[first..=last]
        .iter()
        .copied()
        .fold(0.0, f32::max)
}

fn superflux_onset_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    let mut output = vec![0.0; frames.len()];
    let weights = (0..LOG_BANDS)
        .map(|band| onset_band_weight(log_band_center_hz(band)))
        .collect::<Vec<_>>();

    for index in 2..frames.len() {
        let mut total = 0.0;
        let mut weight_sum = 0.0;

        for (band, weight) in weights.iter().copied().enumerate() {
            let previous = previous_band_max(frames, index, band, 1)
                .max(previous_band_max(frames, index, band, 2) * 0.86);

            let difference = (frames[index].log_bands[band] - previous).max(0.0);

            if difference > 0.0 {
                total += difference * weight;
                weight_sum += weight;
            }
        }

        if weight_sum > 0.0 {
            output[index] = total / weight_sum;
        }
    }

    output
}

fn fuse_detector_scores(spectral: &[f32], envelope: &[f32], superflux: &[f32]) -> Vec<f32> {
    let spectral = normalize_series(spectral, 0.985);
    let envelope = normalize_series(envelope, 0.985);
    let superflux = normalize_series(superflux, 0.985);

    spectral
        .iter()
        .zip(&envelope)
        .zip(&superflux)
        .map(|((&spec, &env), &flux)| {
            let agreement = spec.min(env).max(flux.min(env) * 0.92);
            let support = ((spec.max(flux) * env).sqrt() + (spec * flux).sqrt() * 0.45) / 1.45;
            let strongest = spec.max(env).max(flux);

            let mut score =
                agreement * 0.58 + support * 0.34 + flux * 0.25 + env * 0.16 + strongest * 0.04;

            if agreement < 0.10 {
                score *= if strongest > 0.84 { 0.62 } else { 0.34 };
            } else if agreement < 0.24 {
                score *= 0.78;
            }

            score.max(0.0)
        })
        .collect()
}

fn frame_activity(frame: &FrameEnergy) -> f32 {
    frame.wide * 0.34
        + frame.bass * 0.22
        + frame.body * 0.16
        + frame.rms * 0.14
        + frame.presence * 0.10
        + frame.attack * 0.04
}

fn frame_medians(frames: &[FrameEnergy], start: usize, end: usize) -> FrameEnergy {
    let end = end.min(frames.len());

    if start >= end {
        return FrameEnergy::default();
    }

    let slice = &frames[start..end];

    let median = |read: fn(&FrameEnergy) -> f32| {
        let values = slice.iter().map(read).collect::<Vec<_>>();
        robust_percentile(&values, 0.50)
    };

    FrameEnergy {
        time: slice[slice.len() / 2].time,
        bass: median(|frame| frame.bass),
        body: median(|frame| frame.body),
        attack: median(|frame| frame.attack),
        presence: median(|frame| frame.presence),
        wide: median(|frame| frame.wide),
        flux: median(|frame| frame.flux),
        rms: median(|frame| frame.rms),
        peak: median(|frame| frame.peak),
        log_bands: [0.0; LOG_BANDS],
    }
}

fn drop_rise_transition_scores(frames: &[FrameEnergy]) -> Vec<f32> {
    let mut output = vec![0.0; frames.len()];
    let step = median_frame_step_seconds(frames);

    if frames.len() < 24 || step <= 0.0 {
        return output;
    }

    let prior_window = ((4.20 / step).round() as usize).clamp(24, 600);
    let quiet_window = ((0.85 / step).round() as usize).clamp(4, 120);
    let current_window = ((0.20 / step).round() as usize).clamp(2, 32);

    let activity = frames.iter().map(frame_activity).collect::<Vec<_>>();
    let reference = robust_percentile(&activity, 0.70).max(EPSILON);

    for index in prior_window + quiet_window..frames.len() {
        let quiet_start = index - quiet_window;
        let prior_start = quiet_start - prior_window;
        let current_end = (index + current_window).min(frames.len());

        let prior = robust_percentile(&activity[prior_start..quiet_start], 0.96).max(EPSILON);
        let quiet = robust_percentile(&activity[quiet_start..index], 0.50).max(EPSILON);
        let current = activity[index..current_end]
            .iter()
            .copied()
            .fold(0.0, f32::max)
            .max(EPSILON);

        let drop = ((prior - quiet) / prior).clamp(0.0, 1.0);
        let rise = ((current - quiet) / quiet.max(reference * 0.08)).max(0.0);
        let recovery = (current / prior.max(reference * 0.20)).clamp(0.0, 1.8);
        let presence = (current / reference).clamp(0.0, 1.8);

        if drop < 0.18 || rise < 0.26 || presence < 0.36 {
            continue;
        }

        let baseline = frame_medians(frames, quiet_start, index);
        let frame = frames[index];
        let onset = positive_rise(frame.bass, baseline.bass) * 0.24
            + positive_rise(frame.body, baseline.body) * 0.18
            + positive_rise(frame.attack, baseline.attack) * 0.22
            + positive_rise(frame.wide, baseline.wide) * 0.12
            + positive_rise(frame.rms, baseline.rms) * 0.16
            + positive_rise(frame.peak, baseline.peak) * 0.08;

        if onset >= 0.16 {
            output[index] = drop * 0.40
                + rise.min(1.8) * 0.24
                + recovery.min(1.4) * 0.18
                + onset.min(1.6) * 0.22;
        }
    }

    output
}

fn locally_stabilize_scores(frames: &[FrameEnergy], scores: &[f32]) -> Vec<f32> {
    let step = median_frame_step_seconds(frames);

    if scores.len() < 8 || step <= 0.0 {
        return scores.to_vec();
    }

    let radius = ((8.0 / step).round() as usize).clamp(16, 1200);
    let global = robust_percentile(scores, 0.72).max(EPSILON);
    let floor = global * 0.18;

    let mut output = vec![0.0; scores.len()];
    let mut window = Vec::with_capacity(radius * 2 + 1);
    let mut deviations = Vec::with_capacity(radius * 2 + 1);

    for index in 0..scores.len() {
        let first = index.saturating_sub(radius);
        let end = (index + radius + 1).min(scores.len());

        window.clear();
        window.extend(
            scores[first..end]
                .iter()
                .copied()
                .filter(|value| value.is_finite() && *value > 0.0),
        );

        if window.len() < 4 {
            continue;
        }

        window.sort_unstable_by(f32::total_cmp);

        let median = percentile_sorted(&window, 0.50);
        let p85 = percentile_sorted(&window, 0.85);
        let p97 = percentile_sorted(&window, 0.97).max(p85 + EPSILON);

        if p85 < floor {
            continue;
        }

        deviations.clear();
        deviations.extend(window.iter().map(|value| (value - median).abs()));

        let middle = deviations.len() / 2;
        deviations.select_nth_unstable_by(middle, f32::total_cmp);
        let mad = deviations[middle].max(EPSILON);

        let threshold = (median + 1.05 * mad).max(p85 * 0.42);
        let score = scores[index];

        if score > threshold {
            let ratio = ((score - threshold) / (p97 - threshold).max(EPSILON)).clamp(0.0, 1.8);
            let confidence = ((p85 - floor) / global).clamp(0.35, 1.0);

            output[index] = soft_compress(ratio) * confidence;
        }
    }

    output
}

fn median_frame_step_seconds(frames: &[FrameEnergy]) -> f64 {
    let mut steps = frames
        .windows(2)
        .filter_map(|pair| {
            let difference = pair[1].time - pair[0].time;
            (difference.is_finite() && difference > 0.0).then_some(difference)
        })
        .collect::<Vec<_>>();

    if steps.is_empty() {
        return 0.0;
    }

    let middle = steps.len() / 2;
    steps.select_nth_unstable_by(middle, f64::total_cmp);
    steps[middle]
}

fn normalized_lag_correlation(values: &[f32], lag: usize) -> f32 {
    if lag == 0 || lag >= values.len() {
        return 0.0;
    }

    let mut cross = 0.0_f64;
    let mut left_energy = 0.0_f64;
    let mut right_energy = 0.0_f64;

    for index in lag..values.len() {
        let left = finite_nonnegative(values[index]) as f64;
        let right = finite_nonnegative(values[index - lag]) as f64;

        if left < 0.025 && right < 0.025 {
            continue;
        }

        cross += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }

    let denominator = (left_energy * right_energy).sqrt();

    if denominator <= 1.0e-12 {
        0.0
    } else {
        (cross / denominator).clamp(0.0, 1.0) as f32
    }
}

fn lag_bounds(length: usize, step: f64) -> Option<(usize, usize)> {
    if length < 4 || !step.is_finite() || step <= 0.0 {
        return None;
    }

    let minimum = ((60.0 / MAX_BEAT_BPM) / step).round().max(2.0) as usize;
    let maximum = (((60.0 / MIN_BEAT_BPM) / step).round() as usize).min(length / 2);

    (minimum <= maximum).then_some((minimum, maximum))
}

fn estimate_beat_lag(values: &[f32], step: f64) -> Option<usize> {
    let (minimum, maximum) = lag_bounds(values.len(), step)?;

    let mut best_lag = minimum;
    let mut best_score = 0.0;

    for lag in minimum..=maximum {
        let bpm = 60.0 / (lag as f64 * step);
        let prior = if (75.0..=165.0).contains(&bpm) {
            1.0
        } else {
            0.94
        };

        let score = normalized_lag_correlation(values, lag) * prior;

        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    (best_score >= 0.10).then_some(best_lag)
}

fn prefer_faster_harmonic_lag(values: &[f32], lag: usize, step: f64) -> usize {
    if lag < 4 || step <= 0.0 {
        return lag;
    }

    let faster = lag / 2;
    let bpm = 60.0 / (faster as f64 * step);

    if !(88.0..=205.0).contains(&bpm) {
        return lag;
    }

    let base_correlation = normalized_lag_correlation(values, lag);
    let faster_correlation = normalized_lag_correlation(values, faster);

    if base_correlation >= 0.08
        && faster_correlation >= 0.22
        && faster_correlation / base_correlation.max(EPSILON) >= 0.70
    {
        faster
    } else {
        lag
    }
}

fn reinforce_rhythmic_scores(frames: &[FrameEnergy], scores: &[f32]) -> Vec<f32> {
    let step = median_frame_step_seconds(frames);
    let normalized = normalize_series(scores, 0.985);

    let Some(lag) = estimate_beat_lag(&normalized, step) else {
        return scores.to_vec();
    };

    let correlation = normalized_lag_correlation(&normalized, lag);
    let confidence = ((correlation - 0.09) / 0.24).clamp(0.0, 1.0);

    scores
        .iter()
        .enumerate()
        .map(|(index, score)| {
            let mut support = 0.0_f32;

            for multiple in 1..=2 {
                let offset = lag * multiple;
                let weight = if multiple == 1 { 1.0 } else { 0.62 };

                if index >= offset {
                    support = support.max(normalized[index - offset] * weight);
                }

                if let Some(value) = normalized.get(index + offset) {
                    support = support.max(*value * weight);
                }
            }

            score * (1.0 + support.clamp(0.0, 1.0) * confidence * 0.34)
        })
        .collect()
}

fn has_direct_onset_evidence(frames: &[FrameEnergy], index: usize, prior_frames: usize) -> bool {
    if index == 0 || index >= frames.len() {
        return false;
    }

    let baseline = frame_medians(frames, index.saturating_sub(prior_frames), index);
    let frame = frames[index];

    let bass = positive_rise(frame.bass, baseline.bass);
    let body = positive_rise(frame.body, baseline.body);
    let attack = positive_rise(frame.attack, baseline.attack);
    let presence = positive_rise(frame.presence, baseline.presence);
    let wide = positive_rise(frame.wide, baseline.wide);
    let rms = positive_rise(frame.rms, baseline.rms);
    let peak = positive_rise(frame.peak, baseline.peak);

    let percussion = bass * 0.36 + body * 0.30 + attack * 0.28;
    let melodic = presence * 0.42 + wide * 0.20;
    let envelope = rms * 0.62 + peak * 0.38;

    (percussion >= 0.16 && envelope >= 0.050)
        || (percussion >= 0.12 && attack >= 0.18 && peak >= 0.050)
        || (percussion + melodic * 0.35 >= 0.30 && wide >= 0.065)
}

fn active_rhythm_regions(
    frames: &[FrameEnergy],
    stable: &[f32],
    lag: usize,
    step: f64,
) -> Vec<(usize, usize)> {
    let length = frames.len().min(stable.len());

    if length == 0 || lag == 0 || step <= 0.0 {
        return Vec::new();
    }

    let evidence = stable[..length]
        .iter()
        .enumerate()
        .filter_map(|(index, score)| {
            (*score > 0.0 && has_direct_onset_evidence(frames, index, lag.clamp(4, 32)))
                .then_some(index)
        })
        .collect::<Vec<_>>();

    if evidence.len() < 2 {
        return Vec::new();
    }

    let maximum_gap = (lag * 3).max((1.1 / step).round() as usize);
    let mut regions = Vec::new();
    let mut first = evidence[0];
    let mut previous = first;
    let mut count = 1;

    for index in evidence.into_iter().skip(1) {
        if index - previous > maximum_gap {
            if count >= 2 {
                regions.push((first.saturating_sub(lag), (previous + lag + 1).min(length)));
            }

            first = index;
            count = 1;
        } else {
            count += 1;
        }

        previous = index;
    }

    if count >= 2 {
        regions.push((first.saturating_sub(lag), (previous + lag + 1).min(length)));
    }

    // Merge overlapping padded regions before tracking, not after generating
    // two potentially inconsistent beat paths.
    let mut merged: Vec<(usize, usize)> = Vec::new();

    for (start, end) in regions {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }

        merged.push((start, end));
    }

    merged
}

fn estimate_local_beat_lags(scores: &[f32], step: f64, global_lag: usize) -> Vec<usize> {
    let Some((minimum, maximum)) = lag_bounds(scores.len(), step) else {
        return vec![global_lag.max(2); scores.len()];
    };

    let anchor_step = ((2.0 / step).round() as usize).max(1);
    let half_window = ((5.0 / step).round() as usize).max(global_lag * 3);

    let mut anchors = Vec::new();
    let mut previous = global_lag.clamp(minimum, maximum);

    for anchor in (0..scores.len()).step_by(anchor_step) {
        let first = anchor.saturating_sub(half_window);
        let end = (anchor + half_window + 1).min(scores.len());
        let local = &scores[first..end];

        let mut best_lag = previous;
        let mut best_score = f32::NEG_INFINITY;

        for lag in minimum..=maximum.min(local.len().saturating_sub(1)) {
            let correlation = normalized_lag_correlation(local, lag);

            if correlation <= 0.0 {
                continue;
            }

            let bpm = 60.0 / (lag as f64 * step);
            let prior = (-0.5 * (bpm / 120.0).log2().powi(2) / 0.78_f64.powi(2)).exp() as f32;

            let continuity = (lag as f64 / previous as f64).log2().abs() as f32;
            let global_distance = (lag as f64 / global_lag.max(1) as f64).log2().abs() as f32;

            let harmonic = normalized_lag_correlation(local, lag * 2) * 0.16;
            let subdivision = if lag >= minimum * 2 {
                normalized_lag_correlation(local, lag / 2)
            } else {
                0.0
            };

            let score = correlation * (0.78 + prior * 0.22) + harmonic
                - subdivision * 0.20
                - continuity.min(2.0) * 0.11
                - global_distance.min(2.0) * 0.035;

            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }

        if best_score < 0.10 {
            best_lag = previous;
        }

        best_lag = prefer_faster_harmonic_lag(local, best_lag, step).clamp(minimum, maximum);

        let preferred_bpm = 60.0 / (global_lag.max(1) as f64 * step);

        if preferred_bpm >= 90.0 && best_lag as f64 > global_lag as f64 * 1.45 {
            best_lag = global_lag.clamp(minimum, maximum);
        }

        anchors.push((anchor, best_lag));
        previous = best_lag;
    }

    if anchors.last().map(|entry| entry.0) != Some(scores.len() - 1) {
        anchors.push((scores.len() - 1, previous));
    }

    let mut curve = vec![previous; scores.len()];

    for pair in anchors.windows(2) {
        let (left_index, left_lag) = pair[0];
        let (right_index, right_lag) = pair[1];
        let width = (right_index - left_index).max(1);

        for (offset, slot) in curve[left_index..=right_index].iter_mut().enumerate() {
            let t = offset as f64 / width as f64;

            *slot = ((left_lag as f64 * (1.0 - t) + right_lag as f64 * t).round() as usize)
                .clamp(minimum, maximum);
        }
    }

    curve
}

fn smoothed_beat_local_scores(scores: &[f32], lag_curve: &[usize]) -> Vec<f32> {
    if scores.is_empty() || scores.len() != lag_curve.len() {
        return Vec::new();
    }

    let mean = scores.iter().map(|value| *value as f64).sum::<f64>() / scores.len() as f64;

    let variance = scores
        .iter()
        .map(|value| (*value as f64 - mean).powi(2))
        .sum::<f64>()
        / scores.len().saturating_sub(1).max(1) as f64;

    let deviation = variance.sqrt().max(1.0e-6) as f32;
    let normalized = scores
        .iter()
        .map(|score| (score / deviation).max(0.0))
        .collect::<Vec<_>>();

    let mut output = vec![0.0; scores.len()];

    for index in 0..scores.len() {
        let lag = lag_curve[index].max(2);
        let radius = (lag / 3).max(2);
        let sigma = (lag as f32 / 16.0).max(1.0);
        let first = index.saturating_sub(radius);
        let end = (index + radius + 1).min(scores.len());

        let mut weighted = 0.0;
        let mut weight_sum = 0.0;

        for (offset, value) in normalized[first..end].iter().enumerate() {
            let distance = (first + offset) as f64 - index as f64;
            let weight = (-0.5 * (distance as f32 / sigma).powi(2)).exp();

            weighted += value * weight;
            weight_sum += weight;
        }

        output[index] = weighted / weight_sum.max(EPSILON);
    }

    output
}

fn dynamic_programming_beat_path(scores: &[f32], lag_curve: &[usize]) -> Vec<usize> {
    if scores.len() < 3 || scores.len() != lag_curve.len() {
        return Vec::new();
    }

    let local = smoothed_beat_local_scores(scores, lag_curve);
    let maximum = local.iter().copied().fold(0.0_f32, f32::max);

    if maximum <= 0.0 {
        return Vec::new();
    }

    let mut cumulative = vec![0.0_f64; scores.len()];
    let mut backlink = vec![None; scores.len()];

    for index in 0..scores.len() {
        let target = lag_curve[index].max(2);
        let minimum_distance = (target / 2).max(2);
        let maximum_distance = target * 2;

        // A new path can begin here instead of inheriting a negative score.
        let mut best = 0.0_f64;
        let mut predecessor = None;

        if index >= minimum_distance {
            let first = index.saturating_sub(maximum_distance);
            let last = index - minimum_distance;

            #[allow(clippy::needless_range_loop)]
            for candidate_index in first..=last {
                let distance = index - candidate_index;
                let ratio = distance as f64 / target as f64;
                let timing_error = ratio.ln();

                let penalty = 18.0 * timing_error * timing_error + 3.0 * (ratio - 1.0).max(0.0);

                let candidate = cumulative[candidate_index] - penalty;

                if candidate > best {
                    best = candidate;
                    predecessor = Some(candidate_index);
                }
            }
        }

        cumulative[index] = local[index] as f64 + best;

        if local[index] >= maximum * 0.02 || predecessor.is_some() {
            backlink[index] = predecessor;
        }
    }

    let maxima = (0..scores.len())
        .filter(|&index| {
            let left = index == 0 || cumulative[index] >= cumulative[index - 1];
            let right = index + 1 == scores.len() || cumulative[index] > cumulative[index + 1];

            left && right
        })
        .collect::<Vec<_>>();

    let Some(tail) = maxima
        .iter()
        .copied()
        .max_by(|left, right| cumulative[*left].total_cmp(&cumulative[*right]))
    else {
        return Vec::new();
    };

    let mut path = Vec::new();
    let mut cursor = tail;

    loop {
        path.push(cursor);

        match backlink[cursor] {
            Some(previous) if previous < cursor => cursor = previous,
            _ => break,
        }
    }

    path.reverse();
    trim_weak_path_edges(&mut path, &local);
    path
}

fn trim_weak_path_edges(path: &mut Vec<usize>, local: &[f32]) {
    if path.len() < 3 {
        return;
    }

    let scores = path
        .iter()
        .filter_map(|index| local.get(*index).copied())
        .collect::<Vec<_>>();

    let threshold = robust_percentile(&scores, 0.50) * 0.22;
    let mut first = 0;
    let mut end = path.len();

    while end - first > 2 && local[path[first]] < threshold {
        first += 1;
    }

    while end - first > 2 && local[path[end - 1]] < threshold {
        end -= 1;
    }

    path.truncate(end);

    if first > 0 {
        path.drain(..first);
    }
}

fn detect_beat_grid_events(
    samples: &[f32],
    sample_rate: u32,
    frames: &[FrameEnergy],
) -> Vec<Event> {
    let step = median_frame_step_seconds(frames);

    if step <= 0.0 {
        return Vec::new();
    }

    let spectral = spectral_novelty_scores(frames);
    let envelope = envelope_onset_scores(frames);
    let superflux = superflux_onset_scores(frames);
    let transitions = drop_rise_transition_scores(frames);

    let mut raw = fuse_detector_scores(&spectral, &envelope, &superflux);

    for (score, transition) in raw.iter_mut().zip(transitions) {
        *score += transition * 0.34;
    }

    let reinforced = reinforce_rhythmic_scores(frames, &raw);
    let stable = locally_stabilize_scores(frames, &reinforced);
    let raw_normalized = normalize_series(&raw, 0.985);
    let stable_normalized = normalize_series(&stable, 0.985);

    let tracking = raw_normalized
        .iter()
        .zip(&stable_normalized)
        .map(|(&raw, &stable)| {
            if stable > 0.0 {
                stable * 0.72 + raw * 0.28
            } else {
                raw * 0.10
            }
        })
        .collect::<Vec<_>>();

    let Some(global_lag) = estimate_beat_lag(&stable_normalized, step) else {
        return Vec::new();
    };

    let pulse_lag = prefer_faster_harmonic_lag(&raw_normalized, global_lag, step);

    let normalized = normalize_series(&tracking, 0.985);
    let mut beats = Vec::new();

    for (start, end) in active_rhythm_regions(frames, &stable, global_lag, step) {
        let region = &normalized[start..end];
        let local_lags = estimate_local_beat_lags(region, step, pulse_lag);

        for relative in dynamic_programming_beat_path(region, &local_lags) {
            let index = start + relative;
            let time = snap_event_time(samples, sample_rate, frames[index].time);

            beats.push((time, tracking[index]));
        }
    }

    let mut beats = suppress_duplicates(beats, (60.0 / MAX_BEAT_BPM) * 0.42);
    calibrate_beat_grid_scores(&mut beats);

    beats
        .into_iter()
        .map(|(time, score)| Event {
            time,
            score: round_score(score),
        })
        .collect()
}

fn suppress_duplicates(mut peaks: Vec<(f64, f32)>, gap: f64) -> Vec<(f64, f32)> {
    peaks.retain(|(time, score)| time.is_finite() && *time >= 0.0 && score.is_finite());

    peaks.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.total_cmp(&right.0))
    });

    let mut kept: Vec<(f64, f32)> = Vec::new();

    for candidate in peaks {
        let insertion = kept.partition_point(|existing| existing.0 < candidate.0);

        let overlaps_left = insertion > 0 && (candidate.0 - kept[insertion - 1].0).abs() < gap;

        let overlaps_right =
            insertion < kept.len() && (candidate.0 - kept[insertion].0).abs() < gap;

        if !overlaps_left && !overlaps_right {
            kept.insert(insertion, candidate);
        }
    }

    kept
}

fn calibrate_beat_grid_scores(beats: &mut [(f64, f32)]) {
    if beats.is_empty() {
        return;
    }

    if beats.len() == 1 {
        beats[0].1 = 0.60;
        return;
    }

    let mut indices = (0..beats.len()).collect::<Vec<_>>();
    indices.sort_by(|left, right| beats[*left].1.total_cmp(&beats[*right].1));

    // Equal evidence receives equal salience rather than an arbitrary rank
    // determined by chronological order.
    let mut first = 0;

    while first < indices.len() {
        let score = beats[indices[first]].1;
        let mut end = first + 1;

        while end < indices.len() && beats[indices[end]].1 == score {
            end += 1;
        }

        let rank = (first + end - 1) as f32 * 0.5;
        let percentile = rank / (beats.len() - 1) as f32;
        let calibrated = (0.22 + percentile * 0.75).clamp(0.22, 0.97);

        for index in &indices[first..end] {
            beats[*index].1 = calibrated;
        }

        first = end;
    }
}

/*
 * Onset refinement with a local prefix sum.
 *
 * The original repeated range summations made each snap approximately
 * quadratic in the search-window length. Prefix sums make each envelope
 * query O(1), without allocating a full-track prefix buffer.
 */
fn snap_event_time(samples: &[f32], sample_rate: u32, estimated_time: f64) -> f64 {
    if samples.len() < 2 || sample_rate == 0 || !estimated_time.is_finite() {
        return 0.0;
    }

    let rate = sample_rate as f64;
    let last_time = (samples.len() - 1) as f64 / rate;
    let estimated_time = estimated_time.clamp(0.0, last_time);
    let estimated = (estimated_time * rate).round() as usize;

    let back = (0.055 * rate).round() as usize;
    let forward = (0.090 * rate).round() as usize;
    let pre_window = ((0.016 * rate).round() as usize).max(1);
    let post_window = ((0.012 * rate).round() as usize).max(1);

    let start = estimated.saturating_sub(back).max(1);
    let end = estimated.saturating_add(forward).min(samples.len() - 1);

    if start >= end {
        return estimated_time;
    }

    let prefix_start = start.saturating_sub(pre_window);
    let prefix_end = end.saturating_add(post_window).min(samples.len() - 1);

    let mut prefix = Vec::with_capacity(prefix_end - prefix_start + 2);
    prefix.push(0.0_f64);

    let mut sum = 0.0_f64;

    for sample in &samples[prefix_start..=prefix_end] {
        sum += safe_sample(*sample).abs() as f64;
        prefix.push(sum);
    }

    let mean = |first: usize, end_exclusive: usize| -> f32 {
        if first >= end_exclusive {
            return 0.0;
        }

        let first = first.max(prefix_start);
        let end_exclusive = end_exclusive.min(prefix_end + 1);

        if first >= end_exclusive {
            return 0.0;
        }

        ((prefix[end_exclusive - prefix_start] - prefix[first - prefix_start])
            / (end_exclusive - first) as f64) as f32
    };

    let local_mean = mean(start, end + 1).max(EPSILON);
    let mut best_index = start;
    let mut best_score = 0.0;
    let mut candidates = Vec::with_capacity(end - start + 1);

    for index in start..=end {
        let pre = mean(index.saturating_sub(pre_window), index).max(local_mean * 0.18);
        let post = mean(index, index.saturating_add(post_window).saturating_add(1));

        let rise = ((post - pre) / pre.max(EPSILON)).max(0.0);
        let current = safe_sample(samples[index]);
        let previous = safe_sample(samples[index - 1]);
        let impulse = ((current - previous).abs() * 0.70 + current.abs() * 0.30) / local_mean;
        let score = rise * 0.82 + impulse * 0.18;

        candidates.push((index, score, rise, impulse));

        if score > best_score {
            best_score = score;
            best_index = index;
        }
    }

    if best_score <= 0.42 {
        return estimated_time;
    }

    for (index, score, rise, impulse) in candidates {
        if index > best_index {
            break;
        }

        if score >= best_score * 0.36 && (rise >= 0.22 || impulse >= 2.4) {
            best_index = index;
            break;
        }
    }

    (best_index as f64 / rate - 0.008).clamp(0.0, last_time)
}

fn finite_nonnegative(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn normalize_series(values: &[f32], percentile: f32) -> Vec<f32> {
    let normalizer = robust_percentile(values, percentile).max(EPSILON);

    values
        .iter()
        .map(|value| soft_compress(finite_nonnegative(*value) / normalizer))
        .collect()
}

fn soft_compress(value: f32) -> f32 {
    let value = finite_nonnegative(value);

    if value <= 1.0 {
        value
    } else {
        1.0 + value.ln() * 0.4
    }
}

fn percentile_index(length: usize, percentile: f32) -> usize {
    if length <= 1 {
        return 0;
    }

    let percentile = if percentile.is_finite() {
        percentile.clamp(0.0, 1.0)
    } else {
        0.5
    };

    ((length - 1) as f64 * percentile as f64).round() as usize
}

fn robust_percentile(values: &[f32], percentile: f32) -> f32 {
    let mut valid = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();

    if valid.is_empty() {
        return 0.0;
    }

    let index = percentile_index(valid.len(), percentile);
    valid.select_nth_unstable_by(index, f32::total_cmp);
    valid[index]
}

fn percentile_sorted(sorted: &[f32], percentile: f32) -> f32 {
    if sorted.is_empty() {
        0.0
    } else {
        sorted[percentile_index(sorted.len(), percentile)]
    }
}

fn round_time(value: f64) -> f64 {
    // Microseconds avoid rounding source-range endpoints across video frames.
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn round_score(value: f32) -> f32 {
    (finite_nonnegative(value).clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FILE_ID: AtomicU64 = AtomicU64::new(0);

    struct TestFile(std::path::PathBuf);

    impl TestFile {
        fn new() -> Self {
            let id = NEXT_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();

            Self(std::env::temp_dir().join(format!(
                "autocut-audio-{}-{timestamp}-{id}.wav",
                std::process::id()
            )))
        }

        fn as_str(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn write_wav(path: &Path, samples: &[i16], sample_rate: u32) -> io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;

        let data_bytes = u32::try_from(samples.len() * 2)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "WAV too large"))?;

        file.write_all(b"RIFF")?;
        file.write_all(&(36u32 + data_bytes).to_le_bytes())?;
        file.write_all(b"WAVEfmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?;
        file.write_all(&sample_rate.to_le_bytes())?;
        file.write_all(&(sample_rate * 2).to_le_bytes())?;
        file.write_all(&2u16.to_le_bytes())?;
        file.write_all(&16u16.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_bytes.to_le_bytes())?;

        for sample in samples {
            file.write_all(&sample.to_le_bytes())?;
        }

        file.flush()
    }

    fn synthetic_hits(sample_rate: u32, duration: f64, times: &[f64]) -> Vec<f32> {
        let mut samples = vec![0.0; (duration * sample_rate as f64).round() as usize];

        for &time in times {
            let start = (time * sample_rate as f64).round() as usize;
            let length = (0.12 * sample_rate as f64).round() as usize;

            for offset in 0..length {
                let Some(sample) = samples.get_mut(start + offset) else {
                    break;
                };

                let t = offset as f32 / sample_rate as f32;
                let bass = (std::f32::consts::TAU * 82.0 * t).sin() * (-28.0 * t).exp();
                let body = (std::f32::consts::TAU * 420.0 * t).sin() * (-38.0 * t).exp();

                let attack_length = (sample_rate as usize / 400).max(1);
                let attack = if offset < attack_length {
                    (((offset * 37) % 31) as f32 / 15.5 - 1.0)
                        * (1.0 - offset as f32 / attack_length as f32)
                } else {
                    0.0
                };

                *sample += bass * 0.65 + body * 0.25 + attack * 0.25;
            }
        }

        samples
    }

    #[test]
    fn selected_range_is_trimmed_and_has_source_offset() {
        let file = TestFile::new();
        let sample_rate = 100;
        let samples = (0..1000).map(|value| value as i16).collect::<Vec<_>>();

        write_wav(&file.0, &samples, sample_rate).unwrap();

        let (decoded, rate, offset) =
            decode_mono_audio(file.as_str(), Some(2.0), Some(3.0)).unwrap();

        assert_eq!(rate, sample_rate);
        assert_eq!(decoded.len(), 300);
        assert!((decoded[0] - 200.0 / 32768.0).abs() < 1.0e-6);
        assert_eq!(offset, 2.0);
    }

    #[test]
    fn range_past_end_is_rejected() {
        let file = TestFile::new();
        write_wav(&file.0, &[0; 1000], 100).unwrap();

        assert!(decode_mono_audio(file.as_str(), Some(12.0), Some(1.0)).is_err());
    }

    #[test]
    fn range_validation_rejects_nonfinite_and_negative_values() {
        assert!(AnalysisRange::new(Some(f64::NAN), None).is_err());
        assert!(AnalysisRange::new(Some(-1.0), None).is_err());
        assert!(AnalysisRange::new(None, Some(0.0)).is_err());
        assert!(AnalysisRange::new(None, Some(f64::INFINITY)).is_err());
        assert!(AnalysisRange::new(Some(1.0e20), Some(1.0)).is_err());
    }

    #[test]
    fn common_video_rates_use_2048_sample_windows() {
        assert_eq!(analysis_window_size(44_100), 2048);
        assert_eq!(analysis_window_size(48_000), 2048);
        assert_eq!(analysis_hop_size(2048), 512);
    }

    #[test]
    fn silence_and_short_audio_produce_no_events() {
        assert!(detect_events(&[], 48_000).is_empty());
        assert!(detect_events(&[0.0; 32], 48_000).is_empty());
        assert!(detect_events(&vec![0.0; 96_000], 48_000).is_empty());
        assert!(detect_events(&[1.0; 4096], 0).is_empty());
    }

    #[test]
    fn nonfinite_samples_do_not_poison_fft_features() {
        let mut samples = vec![0.0; 8192];
        samples[100] = f32::NAN;
        samples[200] = f32::INFINITY;
        samples[300] = f32::NEG_INFINITY;

        let frames = band_energies(&samples, 48_000);

        assert!(!frames.is_empty());

        for frame in frames {
            assert!(frame.wide.is_finite());
            assert!(frame.flux.is_finite());
            assert!(frame.rms.is_finite());
            assert!(frame.log_bands.iter().all(|value| value.is_finite()));
        }
    }

    #[test]
    fn planar_downmix_uses_a_wide_accumulator() {
        let mut output = Vec::new();

        push_planar_as_mono(
            2,
            3,
            |channel, frame| match frame {
                0 => 0.5,
                1 => {
                    if channel == 0 {
                        1.0
                    } else {
                        -1.0
                    }
                }
                _ => f32::NAN,
            },
            &mut output,
        );

        assert_eq!(output, vec![0.5, 0.0, 0.0]);
    }

    #[test]
    fn duplicate_suppression_keeps_stronger_candidate() {
        let result = suppress_duplicates(vec![(1.0, 0.4), (1.02, 0.9), (1.5, 0.7)], 0.1);

        assert_eq!(result, vec![(1.02, 0.9), (1.5, 0.7)]);
    }

    #[test]
    fn equal_evidence_receives_equal_scores() {
        let mut beats = vec![(0.0, 0.5), (1.0, 0.5), (2.0, 0.5)];
        calibrate_beat_grid_scores(&mut beats);

        assert_eq!(beats[0].1, beats[1].1);
        assert_eq!(beats[1].1, beats[2].1);
    }

    #[test]
    fn percentile_ignores_nonfinite_values() {
        assert_eq!(
            robust_percentile(&[f32::NAN, 1.0, 2.0, 3.0, f32::INFINITY], 0.5),
            2.0
        );

        assert_eq!(robust_percentile(&[], 0.5), 0.0);
    }

    #[test]
    fn supported_half_time_harmonic_can_be_resolved() {
        let mut values = vec![0.0; 1000];

        for index in (20..1000).step_by(25) {
            values[index] = 1.0;
        }

        assert_eq!(prefer_faster_harmonic_lag(&values, 50, 0.02), 25);
    }

    #[test]
    fn beat_tracker_returns_an_ordered_path() {
        let mut scores = vec![0.0; 400];

        for index in (20..380).step_by(40) {
            scores[index] = 1.0;
        }

        let path = dynamic_programming_beat_path(&scores, &vec![40; scores.len()]);

        assert!(path.len() >= 6);
        assert!(path.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn snap_stays_inside_the_audio_buffer() {
        let samples = synthetic_hits(48_000, 2.0, &[0.5, 1.0, 1.5]);

        for estimated in [-10.0, 0.0, 0.52, 1.52, 20.0] {
            let snapped = snap_event_time(&samples, 48_000, estimated);

            assert!(snapped.is_finite());
            assert!(snapped >= 0.0);
            assert!(snapped < 2.0);
        }
    }

    #[test]
    fn repeated_percussion_produces_a_usable_grid() {
        let expected = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
        let samples = synthetic_hits(48_000, 4.0, &expected);
        let events = detect_events(&samples, 48_000);

        let matched = expected
            .iter()
            .filter(|target| {
                events
                    .iter()
                    .any(|event| (event.time - **target).abs() <= 0.09)
            })
            .count();

        assert!(
            matched >= 4,
            "matched {matched}/6 repeated hits; events: {events:?}"
        );

        assert!(events.windows(2).all(|pair| pair[0].time <= pair[1].time));
        assert!(events.iter().all(|event| {
            event.time.is_finite() && event.score.is_finite() && (0.0..=1.0).contains(&event.score)
        }));
    }
}
