use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fmt;

/// Command-line options consumed by the analyzer.
///
/// `media_path` remains a String for compatibility with existing callers.
/// Non-UTF-8 arguments are rejected explicitly rather than panicking or
/// silently altering a filesystem path.
///
/// The media path must be a single argument. Shell users should quote paths
/// containing spaces; process-launch APIs should pass the path as one item.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AnalyzerOptions {
    pub(crate) media_path: String,
    pub(crate) start_seconds: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) help: bool,
    pub(crate) version: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArgumentError {
    message: String,
}

impl ArgumentError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ArgumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ArgumentError {}

pub(crate) fn parse_args() -> Result<AnalyzerOptions, Box<dyn Error>> {
    // env::args() can panic when an argument is not valid Unicode.
    parse_args_from(env::args_os().skip(1))
}

/// Parses arguments without the executable name.
///
/// Accepted forms:
///
/// --start 1.5
/// --start=1.5
/// --duration 10
/// --duration=10
/// --help / -h
/// --version / -V
/// -- <media-file-path>
///
/// Options must precede the media path. Duplicate numeric options and
/// additional positional arguments are rejected. Help and version waive the
/// path requirement but do not suppress malformed-argument errors.
pub(crate) fn parse_args_from<I, S>(args: I) -> Result<AnalyzerOptions, Box<dyn Error>>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into).peekable();

    if args.peek().is_none() {
        return Err(ArgumentError::new(usage()).into());
    }

    let mut options = AnalyzerOptions {
        media_path: String::new(),
        start_seconds: None,
        duration_seconds: None,
        help: false,
        version: false,
    };

    let mut options_ended = false;
    let mut has_path = false;

    while let Some(raw) = args.next() {
        let arg = utf8_argument(raw)?;

        if has_path {
            if !options_ended && arg.starts_with('-') {
                return Err(ArgumentError::new(format!(
                    "options must appear before the media path: {arg}"
                ))
                .into());
            }

            return Err(ArgumentError::new(format!(
                "unexpected additional argument: {arg:?}; \
                 provide exactly one media path and quote paths containing spaces"
            ))
            .into());
        }

        if options_ended {
            set_media_path(&mut options, arg)?;
            has_path = true;
            continue;
        }

        match arg.as_str() {
            "--" => {
                options_ended = true;
            }

            "--help" | "-h" => {
                options.help = true;
            }

            "--version" | "-V" => {
                options.version = true;
            }

            "--start" => {
                reject_duplicate(options.start_seconds, "--start")?;
                options.start_seconds = Some(parse_seconds_flag(
                    next_flag_value(&mut args, "--start")?,
                    "--start",
                    true,
                )?);
            }

            "--duration" => {
                reject_duplicate(options.duration_seconds, "--duration")?;
                options.duration_seconds = Some(parse_seconds_flag(
                    next_flag_value(&mut args, "--duration")?,
                    "--duration",
                    false,
                )?);
            }

            _ if arg.starts_with("--start=") => {
                reject_duplicate(options.start_seconds, "--start")?;
                options.start_seconds = Some(parse_seconds_flag(
                    &arg["--start=".len()..],
                    "--start",
                    true,
                )?);
            }

            _ if arg.starts_with("--duration=") => {
                reject_duplicate(options.duration_seconds, "--duration")?;
                options.duration_seconds = Some(parse_seconds_flag(
                    &arg["--duration=".len()..],
                    "--duration",
                    false,
                )?);
            }

            _ if arg.starts_with('-') => {
                return Err(ArgumentError::new(format!(
                    "unsupported option: {arg}; \
                     use -- before a media filename beginning with '-'"
                ))
                .into());
            }

            _ => {
                set_media_path(&mut options, arg)?;
                has_path = true;
            }
        }
    }

    if !has_path && !options.help && !options.version {
        return Err(ArgumentError::new("media file path is required").into());
    }

    // Check the actual range, not just each flag independently.
    if let Some(duration) = options.duration_seconds {
        let start = options.start_seconds.unwrap_or(0.0);
        let end = start + duration;

        if !end.is_finite() {
            return Err(ArgumentError::new(
                "--start plus --duration exceeds the supported numeric range",
            )
            .into());
        }

        if end <= start {
            return Err(ArgumentError::new(
                "--duration is too small to represent at the specified --start",
            )
            .into());
        }
    }

    Ok(options)
}

fn utf8_argument(value: OsString) -> Result<String, ArgumentError> {
    value.into_string().map_err(|_| {
        ArgumentError::new(
            "an argument is not valid UTF-8; this analyzer currently requires \
             UTF-8 arguments and media paths",
        )
    })
}

fn set_media_path(options: &mut AnalyzerOptions, path: String) -> Result<(), ArgumentError> {
    if path.is_empty() {
        return Err(ArgumentError::new("media file path must not be empty"));
    }

    if path.contains('\0') {
        return Err(ArgumentError::new(
            "media file path must not contain a NUL character",
        ));
    }

    // Preserve the exact path. Do not trim, concatenate, or canonicalize it.
    // File existence and accessibility are validated by the media loader.
    options.media_path = path;
    Ok(())
}

fn reject_duplicate(existing: Option<f64>, flag: &str) -> Result<(), ArgumentError> {
    if existing.is_some() {
        return Err(ArgumentError::new(format!(
            "{flag} may only be specified once"
        )));
    }

    Ok(())
}

fn next_flag_value<I>(
    args: &mut std::iter::Peekable<I>,
    flag: &str,
) -> Result<String, ArgumentError>
where
    I: Iterator<Item = OsString>,
{
    let raw = args
        .next()
        .ok_or_else(|| ArgumentError::new(format!("{flag} requires a seconds value")))?;

    let value = utf8_argument(raw)?;

    if value.starts_with("--") || matches!(value.as_str(), "-h" | "-V") {
        return Err(ArgumentError::new(format!(
            "{flag} requires a seconds value before {value}"
        )));
    }

    Ok(value)
}

fn parse_seconds_flag(
    raw: impl AsRef<str>,
    flag: &str,
    allow_zero: bool,
) -> Result<f64, ArgumentError> {
    let raw = raw.as_ref();

    if raw.is_empty() {
        return Err(ArgumentError::new(format!(
            "{flag} requires a seconds value"
        )));
    }

    let seconds = raw.parse::<f64>().map_err(|_| {
        ArgumentError::new(format!("{flag} requires a numeric seconds value: {raw:?}"))
    })?;

    if !seconds.is_finite() {
        return Err(ArgumentError::new(format!(
            "{flag} requires a finite seconds value"
        )));
    }

    if seconds < 0.0 || (!allow_zero && seconds == 0.0) {
        return Err(ArgumentError::new(format!(
            "{flag} must be {}",
            if allow_zero { ">= 0" } else { "> 0" }
        )));
    }

    // Normalize negative zero so downstream formatting does not emit "-0".
    Ok(if seconds == 0.0 { 0.0 } else { seconds })
}

pub(crate) fn usage() -> &'static str {
    "usage: beat_analyzer [--start seconds] [--duration seconds] [--] <media-file-path>\n\
     \x20      beat_analyzer --help\n\
     \x20      beat_analyzer --version\n\
     \n\
     Options must precede the media path.\n\
     --start must be finite and >= 0; --duration must be finite and > 0.\n\
     Numeric options also accept --start=value and --duration=value.\n\
     Quote paths containing spaces. Use -- before paths beginning with '-'."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_are_rejected() {
        assert!(parse_args_from(Vec::<String>::new()).is_err());
    }

    #[test]
    fn help_and_version_do_not_require_a_path() {
        for flag in ["--help", "-h"] {
            let options = parse_args_from([flag]).unwrap();
            assert!(options.help);
            assert!(options.media_path.is_empty());
        }

        for flag in ["--version", "-V"] {
            assert!(parse_args_from([flag]).unwrap().version);
        }
    }

    #[test]
    fn supports_owned_string_arguments() {
        let options = parse_args_from(vec!["song.wav".to_owned()]).unwrap();
        assert_eq!(options.media_path, "song.wav");
    }

    #[test]
    fn parses_separate_numeric_values() {
        let options =
            parse_args_from(["--start", "1.25", "--duration", "2.5", "song.wav"]).unwrap();

        assert_eq!(options.start_seconds, Some(1.25));
        assert_eq!(options.duration_seconds, Some(2.5));
        assert_eq!(options.media_path, "song.wav");
    }

    #[test]
    fn parses_equals_and_scientific_notation() {
        let options = parse_args_from(["--start=1e1", "--duration=2.5e-1", "song.wav"]).unwrap();

        assert_eq!(options.start_seconds, Some(10.0));
        assert_eq!(options.duration_seconds, Some(0.25));
    }

    #[test]
    fn preserves_path_spacing_and_unicode() {
        let path = "  Music/夏の曲 final mix.wav  ";
        let options = parse_args_from([path]).unwrap();

        assert_eq!(options.media_path, path);
    }

    #[test]
    fn does_not_join_multiple_positional_arguments() {
        assert!(parse_args_from(["my", "song.wav"]).is_err());
        assert!(parse_args_from(["song.wav", "other.wav"]).is_err());
    }

    #[test]
    fn end_of_options_allows_a_dash_prefixed_path() {
        let options = parse_args_from(["--", "--song.wav"]).unwrap();
        assert_eq!(options.media_path, "--song.wav");

        let options = parse_args_from(["--", "--help"]).unwrap();
        assert_eq!(options.media_path, "--help");
        assert!(!options.help);
    }

    #[test]
    fn options_after_path_are_rejected() {
        for args in [
            vec!["song.wav", "--duration", "2"],
            vec!["song.wav", "--start=1"],
            vec!["song.wav", "-h"],
            vec!["song.wav", "-V"],
        ] {
            assert!(parse_args_from(args).is_err());
        }
    }

    #[test]
    fn unknown_options_are_rejected() {
        for flag in ["--unknown", "-x", "--help=true", "--version=1"] {
            assert!(parse_args_from([flag]).is_err());
        }
    }

    #[test]
    fn duplicate_numeric_flags_are_rejected() {
        assert!(parse_args_from(["--start", "1", "--start=2", "song.wav"]).is_err());

        assert!(parse_args_from(["--duration=1", "--duration", "2", "song.wav"]).is_err());
    }

    #[test]
    fn missing_or_empty_values_are_rejected() {
        for args in [
            vec!["--start"],
            vec!["--duration"],
            vec!["--start=", "song.wav"],
            vec!["--duration=", "song.wav"],
            vec!["--start", "--duration", "2", "song.wav"],
        ] {
            assert!(parse_args_from(args).is_err());
        }
    }

    #[test]
    fn invalid_seconds_are_rejected() {
        for value in ["NaN", "inf", "-inf", "1e999", "-1", "abc", " "] {
            assert!(parse_args_from(["--start", value, "song.wav"]).is_err());
            assert!(parse_args_from(["--duration", value, "song.wav"]).is_err());
        }

        for value in ["0", "-0", "0.0"] {
            assert!(parse_args_from(["--duration", value, "song.wav"]).is_err());
        }
    }

    #[test]
    fn start_zero_is_allowed_and_normalized() {
        let options = parse_args_from(["--start", "-0", "song.wav"]).unwrap();
        let start = options.start_seconds.unwrap();

        assert_eq!(start, 0.0);
        assert!(!start.is_sign_negative());
    }

    #[test]
    fn missing_empty_and_nul_paths_are_rejected() {
        assert!(parse_args_from(["--start", "1"]).is_err());
        assert!(parse_args_from(["--"]).is_err());
        assert!(parse_args_from([""]).is_err());
        assert!(parse_args_from(["song\0.wav"]).is_err());
    }

    #[test]
    fn overflowing_or_unrepresentable_ranges_are_rejected() {
        assert!(parse_args_from(["--start=1e308", "--duration=1e308", "song.wav"]).is_err());

        assert!(parse_args_from(["--start=1e20", "--duration=1", "song.wav"]).is_err());
    }

    #[test]
    fn help_does_not_hide_invalid_arguments() {
        assert!(parse_args_from(["--help", "--unknown"]).is_err());
        assert!(parse_args_from(["--help", "--duration=-1"]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_arguments_return_an_error_without_panicking() {
        use std::os::unix::ffi::OsStringExt;

        let path = OsString::from_vec(vec![b'a', 0xff, b'.', b'w', b'a', b'v']);
        assert!(parse_args_from([path]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unpaired_utf16_surrogate_returns_an_error_without_panicking() {
        use std::os::windows::ffi::OsStringExt;

        let path = OsString::from_wide(&[0xD800]);
        assert!(parse_args_from([path]).is_err());
    }
}
