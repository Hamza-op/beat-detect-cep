use std::env;
use std::error::Error;

pub(crate) struct AnalyzerOptions {
    pub(crate) media_path: String,
    pub(crate) start_seconds: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) help: bool,
    pub(crate) version: bool,
}

pub(crate) fn parse_args() -> Result<AnalyzerOptions, Box<dyn Error>> {
    parse_args_from(env::args().skip(1))
}

pub(crate) fn parse_args_from<I>(args: I) -> Result<AnalyzerOptions, Box<dyn Error>>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter().peekable();
    if args.peek().is_none() {
        return Err(usage().into());
    }

    let mut start_seconds = None;
    let mut duration_seconds = None;
    let mut path_parts = Vec::new();
    let mut help = false;
    let mut version = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--start" => {
                start_seconds = Some(parse_seconds_flag(args.next(), "--start", true)?);
            }
            "--duration" => {
                duration_seconds = Some(parse_seconds_flag(args.next(), "--duration", false)?);
            }
            "--help" | "-h" => {
                help = true;
            }
            "--version" | "-V" => {
                version = true;
            }
            other if other.starts_with("--") => {
                return Err(format!("unsupported option: {other}").into());
            }
            path_part => {
                path_parts.push(path_part.to_string());
                for remaining in args {
                    if remaining.starts_with("--") {
                        return Err(format!(
                            "options must appear before the media path: {remaining}"
                        )
                        .into());
                    }
                    path_parts.push(remaining);
                }
                break;
            }
        }
    }

    if path_parts.is_empty() && !help && !version {
        return Err("media file path is required".into());
    }

    Ok(AnalyzerOptions {
        media_path: path_parts.join(" "),
        start_seconds,
        duration_seconds,
        help,
        version,
    })
}

fn parse_seconds_flag(
    value: Option<String>,
    flag: &str,
    allow_zero: bool,
) -> Result<f64, Box<dyn Error>> {
    let raw = value.ok_or_else(|| format!("{flag} requires a seconds value"))?;
    let seconds = raw
        .parse::<f64>()
        .map_err(|_| format!("{flag} requires a numeric seconds value: {raw}"))?;
    if !seconds.is_finite() || seconds < 0.0 || (!allow_zero && seconds <= 0.0) {
        return Err(format!("{flag} must be {}", if allow_zero { ">= 0" } else { "> 0" }).into());
    }
    Ok(seconds)
}

fn usage() -> &'static str {
    "usage: beat_analyzer [--start seconds] [--duration seconds] <media-file-path>\n       beat_analyzer --help\n       beat_analyzer --version"
}

#[cfg(test)]
mod tests {
    use super::parse_args_from;

    #[test]
    fn help_and_version_are_successful_options() {
        assert!(parse_args_from(["--help".to_string()]).unwrap().help);
        assert!(parse_args_from(["--version".to_string()]).unwrap().version);
    }

    #[test]
    fn flags_after_path_are_rejected() {
        assert!(parse_args_from([
            "song.wav".to_string(),
            "--duration".to_string(),
            "2".to_string()
        ])
        .is_err());
    }
}
