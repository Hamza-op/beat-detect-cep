use std::error::Error;
use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    match beat_analyzer::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // A downstream consumer may intentionally close its input early.
            // Treat a closed output pipe as normal CLI termination.
            if is_broken_pipe(error.as_ref()) {
                return ExitCode::SUCCESS;
            }

            // Keep stdout reserved for analyzer JSON, help, and version output.
            // Ignore stderr failures rather than panicking while reporting one.
            let stderr = io::stderr();
            let mut stderr = stderr.lock();
            let _ = writeln!(stderr, "beat_analyzer: {error}");

            // Returning allows normal stack cleanup, unlike process::exit().
            ExitCode::FAILURE
        }
    }
}

fn is_broken_pipe(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);

    while let Some(cause) = current {
        if let Some(io_error) = cause.downcast_ref::<io::Error>() {
            if io_error.kind() == io::ErrorKind::BrokenPipe {
                return true;
            }
        }

        // serde_json may wrap a writer error without exposing it as io::Error.
        if let Some(json_error) = cause.downcast_ref::<serde_json::Error>() {
            if json_error.io_error_kind() == Some(io::ErrorKind::BrokenPipe) {
                return true;
            }
        }

        current = cause.source();
    }

    false
}
