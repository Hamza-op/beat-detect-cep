#[cfg(not(windows))]
fn main() {
    eprintln!("AutoCut Studio setup is currently Windows-only.");
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
    println!("AutoCut Studio installed.");
    println!("Restart Premiere Pro, then open: Window -> Extensions -> AutoCut Studio");
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

    const EXTENSION_ID: &str = "com.autocutstudio.panel";
    const NATIVE_PLUGIN_PREFIX: &str = "native/MediaCore/";

    struct FileEntry {
        relative_path: &'static str,
        bytes: &'static [u8],
    }

    include!(concat!(env!("OUT_DIR"), "/generated_files.rs"));

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut log = InstallLog::new()?;
        log.run_header();
        log.line("AutoCut Studio setup started.");

        let target_dir = target_extension_dir()?;
        log.line(&format!("Target: {}", target_dir.display()));

        install_files(&target_dir)?;
        verify_files(&target_dir)?;

        let native_install = install_native_plugins(&mut log);

        let registry_warnings = enable_unsigned_cep();
        for warning in &registry_warnings {
            log.line(&format!("Warning: {warning}"));
        }

        println!("Installed to:");
        println!("{}", target_dir.display());
        println!();
        match native_install {
            NativeInstallStatus::NotPackaged => {
                println!("Native plugin payload: not packaged in this build.");
            }
            NativeInstallStatus::Installed(path) => {
                println!("Native plugin payload installed to:");
                println!("{}", path.display());
            }
            NativeInstallStatus::Failed(message) => {
                println!("Native plugin payload was packaged but could not be installed:");
                println!("{message}");
                println!("Run this setup as Administrator if native .aex plugins are included.");
            }
        }
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

        log.line("AutoCut Studio setup finished.");
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
            return Err("refusing to install outside the AutoCut Studio extension folder".into());
        }

        if target_dir.exists() {
            let existing = target_dir.canonicalize()?;
            if !existing.starts_with(&cep_extensions) {
                return Err("refusing to update a folder outside Adobe CEP extensions".into());
            }
        }

        for file in FILES {
            if file.relative_path.starts_with(NATIVE_PLUGIN_PREFIX) {
                continue;
            }
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
            if file.relative_path.starts_with(NATIVE_PLUGIN_PREFIX) {
                continue;
            }
            let path = target_dir.join(file.relative_path);
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("missing installed file {}: {error}", path.display()))?;
            if metadata.len() == 0 {
                return Err(format!("installed file is empty: {}", path.display()).into());
            }
        }
        Ok(())
    }

    enum NativeInstallStatus {
        NotPackaged,
        Installed(PathBuf),
        Failed(String),
    }

    fn install_native_plugins(log: &mut InstallLog) -> NativeInstallStatus {
        let native_files: Vec<&FileEntry> = FILES
            .iter()
            .filter(|file| file.relative_path.starts_with(NATIVE_PLUGIN_PREFIX))
            .collect();

        if native_files.is_empty() {
            log.line("Native plugin payload: not packaged.");
            return NativeInstallStatus::NotPackaged;
        }

        match native_plugin_dir() {
            Ok(target_dir) => {
                if let Err(error) = write_native_plugins(&target_dir, &native_files) {
                    let message = error.to_string();
                    log.line(&format!("Native plugin install failed: {message}"));
                    return NativeInstallStatus::Failed(message);
                }
                log.line(&format!(
                    "Native plugin payload installed to {}",
                    target_dir.display()
                ));
                NativeInstallStatus::Installed(target_dir)
            }
            Err(error) => {
                let message = error.to_string();
                log.line(&format!("Native plugin path failed: {message}"));
                NativeInstallStatus::Failed(message)
            }
        }
    }

    fn native_plugin_dir() -> Result<PathBuf, Box<dyn Error>> {
        let program_files = env::var_os("ProgramFiles")
            .ok_or("%ProgramFiles% is not set; cannot locate Adobe plugin folder")?;
        Ok(PathBuf::from(program_files)
            .join("Adobe")
            .join("Common")
            .join("Plug-ins")
            .join("7.0")
            .join("MediaCore")
            .join("AutoCutStudio"))
    }

    fn write_native_plugins(target_dir: &Path, files: &[&FileEntry]) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(target_dir)?;
        for file in files {
            let relative = file
                .relative_path
                .strip_prefix(NATIVE_PLUGIN_PREFIX)
                .ok_or("invalid native plugin payload path")?;
            let path = target_dir.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, file.bytes)?;
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
            let log_dir = PathBuf::from(appdata).join("AutoCutStudio");
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
            let _ = writeln!(self.file, "==== AutoCut Studio setup run {timestamp} ====");
        }
    }
}
