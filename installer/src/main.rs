#[cfg(not(windows))]
fn main() {
    eprintln!("Beat Detect setup is currently Windows-only.");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    std::panic::set_hook(Box::new(|panic_info| {
        let _ = windows_installer::write_emergency_log(&format!(
            "Unexpected setup crash: {panic_info}"
        ));
    }));

    if let Err(error) = windows_installer::run() {
        eprintln!("Install failed: {error}");
        eprintln!("A diagnostic log was written if the setup could access your AppData folder.");
        pause();
        std::process::exit(1);
    }

    println!();
    println!("Beat Detect installed.");
    println!("Restart Premiere Pro, then open: Window -> Extensions -> Beat Detect");
    pause();
}

#[cfg(windows)]
fn pause() {
    use std::io::{self, Read};

    println!();
    println!("Press Enter to close.");
    let _ = io::stdin().read(&mut [0_u8]).ok();
}

#[cfg(windows)]
mod windows_installer {
    use chrono::Local;
    use std::env;
    use std::error::Error;
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const EXTENSION_ID: &str = "com.beatdetect.spikemarker";

    struct FileEntry {
        relative_path: &'static str,
        bytes: &'static [u8],
    }

    include!(concat!(env!("OUT_DIR"), "/generated_files.rs"));

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut log = InstallLog::new()?;
        log.run_header();
        log.line("Beat Detect setup started.");

        let target_dir = target_extension_dir()?;
        log.line(&format!("Target: {}", target_dir.display()));

        install_files(&target_dir)?;
        verify_files(&target_dir)?;

        let registry_warnings = enable_unsigned_cep();
        for warning in &registry_warnings {
            log.line(&format!("Warning: {warning}"));
        }

        println!("Installed to:");
        println!("{}", target_dir.display());
        println!();
        if registry_warnings.is_empty() {
            println!("Unsigned CEP debug mode enabled for CSXS.7 through CSXS.15.");
        } else {
            println!("Installed files correctly, but registry setup reported warnings.");
            println!("If the panel does not appear, run this as your Windows user:");
            println!(
                r#"reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f"#
            );
        }
        println!("Install log:");
        println!("{}", log.path.display());

        log.line("Beat Detect setup finished.");
        Ok(())
    }

    pub fn write_emergency_log(message: &str) -> Result<(), Box<dyn Error>> {
        let mut log = InstallLog::new()?;
        log.line(message);
        Ok(())
    }

    fn target_extension_dir() -> Result<PathBuf, Box<dyn Error>> {
        let appdata = env::var_os("APPDATA").ok_or("%APPDATA% is not set")?;
        Ok(PathBuf::from(appdata)
            .join("Adobe")
            .join("CEP")
            .join("extensions")
            .join(EXTENSION_ID))
    }

    fn install_files(target_dir: &Path) -> Result<(), Box<dyn Error>> {
        let parent_dir = target_dir.parent().ok_or("invalid target directory")?;
        if !parent_dir.exists() {
            fs::create_dir_all(parent_dir)?;
        }
        let cep_extensions = parent_dir.canonicalize()?;

        let expected_name = target_dir
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("invalid extension folder name")?;

        if expected_name != EXTENSION_ID {
            return Err("refusing to install outside the Beat Detect extension folder".into());
        }

        if target_dir.exists() {
            let existing = target_dir.canonicalize()?;
            if !existing.starts_with(&cep_extensions) {
                return Err("refusing to update a folder outside Adobe CEP extensions".into());
            }
        }

        for file in FILES {
            let path = target_dir.join(file.relative_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, file.bytes)?;
        }

        Ok(())
    }

    fn verify_files(target_dir: &Path) -> Result<(), Box<dyn Error>> {
        for file in FILES {
            let path = target_dir.join(file.relative_path);
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("missing installed file {}: {error}", path.display()))?;
            if metadata.len() == 0 {
                return Err(format!("installed file is empty: {}", path.display()).into());
            }
        }
        Ok(())
    }

    fn enable_unsigned_cep() -> Vec<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut warnings = Vec::new();
        for version in 7..=15 {
            let path = format!("Software\\Adobe\\CSXS.{version}");
            match hkcu.create_subkey(&path) {
                Ok((key, _)) => {
                    if let Err(error) = key.set_value("PlayerDebugMode", &"1") {
                        warnings.push(format!("{path}: could not set PlayerDebugMode: {error}"));
                    }
                }
                Err(error) => warnings.push(format!("{path}: could not create key: {error}")),
            }
        }
        warnings
    }

    struct InstallLog {
        path: PathBuf,
        file: fs::File,
    }

    impl InstallLog {
        fn new() -> Result<Self, Box<dyn Error>> {
            let appdata = env::var_os("APPDATA").ok_or("%APPDATA% is not set")?;
            let log_dir = PathBuf::from(appdata).join("BeatDetect");
            fs::create_dir_all(&log_dir)?;
            let path = log_dir.join("install.log");
            let file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            Ok(Self { path, file })
        }

        fn line(&mut self, message: &str) {
            let _ = writeln!(self.file, "{message}");
        }

        fn run_header(&mut self) {
            let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S %:z");
            let _ = writeln!(self.file);
            let _ = writeln!(self.file, "==== Beat Detect setup run {timestamp} ====");
        }
    }
}
