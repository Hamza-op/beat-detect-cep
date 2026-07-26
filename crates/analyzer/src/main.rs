fn main() {
    if let Err(error) = beat_analyzer::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
