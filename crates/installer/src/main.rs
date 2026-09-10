use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(not(windows))]
    {
        let _ = writeln!(
            io::stderr().lock(),
            "AutoCut Studio setup is currently Windows-only."
        );
        ExitCode::FAILURE
    }

    #[cfg(windows)]
    {
        windows_main()
    }
}

#[cfg(windows)]
fn windows_main() -> ExitCode {
    let previous_hook = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let _ = windows_installer::write_emergency_log(&format!("Unexpected setup panic: {info}"));
        previous_hook(info);
    }));

    let result = windows_installer::run();

    let exit_code = match result {
        Ok(()) => {
            let _ = writeln!(
                io::stdout().lock(),
                "\nAutoCut Studio installed.\n\
                 Restart Premiere Pro, then open:\n\
                 Window -> Extensions -> AutoCut Studio"
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "\nInstallation failed: {error}");
            ExitCode::FAILURE
        }
    };

    pause_if_interactive();
    exit_code
}

#[cfg(windows)]
fn pause_if_interactive() {
    use std::io::IsTerminal;

    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return;
    }

    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "\nPress Enter to close.");
    let _ = stdout.flush();
    drop(stdout);

    let mut answer = String::new();
    let _ = io::stdin().read_line(&mut answer);
}

#[cfg(windows)]
mod windows_installer {
    use chrono::Local;
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, HashSet};
    use std::env;
    use std::error::Error;
    use std::ffi::c_void;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, IsTerminal, Read, Write};
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Component, Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    type InstallResult<T> = Result<T, Box<dyn Error>>;

    const EXTENSION_ID: &str = "com.autocutstudio.panel";
    const NATIVE_PLUGIN_PREFIX: &str = "native/MediaCore/";
    const PAYLOAD_MANIFEST: &str = "payload-manifest.json";

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PROCESS_SCAN_TIMEOUT: Duration = Duration::from_secs(15);
    const MAX_DIRECTORY_DEPTH: usize = 64;

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct FileEntry {
        relative_path: &'static str,
        bytes: &'static [u8],
    }

    include!(concat!(env!("OUT_DIR"), "/generated_files.rs"));

    /*
     * Security and recovery model:
     *
     * - Validate all embedded paths before writing files.
     * - Reject symlinks/junctions/reparse points in installation paths.
     * - Stage and verify both payloads before replacing either installation.
     * - Preserve backups until both replacements have been verified.
     * - Roll back successful replacements when a later replacement fails.
     * - Never delete a preexisting backup to make room for a new one.
     *
     * The two destination directories are not one atomic filesystem
     * transaction. Power loss or process termination can leave staging or
     * backup directories; their paths are recorded in the install log.
     *
     * Path checks use std::fs and cannot eliminate adversarial TOCTOU races.
     * Installation requires trusted destination ancestors. A hardened
     * privileged service should use handle-relative filesystem operations.
     *
     * Hashes verify payload consistency, not publisher identity. Distribute
     * an Authenticode-signed installer and validate signing in the release
     * pipeline.
     */

    pub fn run() -> InstallResult<()> {
        let _instance_lock = InstallerLock::acquire()?;
        let mut log = InstallLog::new()?;

        log.line("AutoCut Studio setup started.");
        log.line(&format!("Setup version: {}", env!("CARGO_PKG_VERSION")));

        println!("Install log: {}", log.path.display());

        let result = install(&mut log);

        match &result {
            Ok(()) => log.line("AutoCut Studio setup completed successfully."),
            Err(error) => log.line(&format!("INSTALLATION FAILED: {error}")),
        }

        log.sync();
        result
    }

    fn install(log: &mut InstallLog) -> InstallResult<()> {
        verify_embedded_payload()?;

        let cep_files: Vec<&FileEntry> = FILES
            .iter()
            .filter(|file| !file.relative_path.starts_with(NATIVE_PLUGIN_PREFIX))
            .collect();

        let native_files: Vec<&FileEntry> = FILES
            .iter()
            .filter(|file| file.relative_path.starts_with(NATIVE_PLUGIN_PREFIX))
            .collect();

        if cep_files.is_empty() {
            return Err("the installer contains no CEP extension files".into());
        }

        let extension_target = target_extension_dir()?;
        validate_target_name(&extension_target, EXTENSION_ID)?;

        let native_target = if native_files.is_empty() {
            None
        } else {
            let target = native_plugin_dir()?;
            validate_target_name(&target, "AutoCutStudio")?;
            Some(target)
        };

        println!("\nCEP extension destination:");
        println!("{}", extension_target.display());

        if let Some(target) = &native_target {
            println!("\nNative plugin destination:");
            println!("{}", target.display());
        }

        println!(
            "\nThe CEP panel is installed for the Windows account running this setup.\n\
             If UAC used another administrator's credentials, verify that this is\n\
             the account that will run Premiere."
        );

        log.line(&format!("CEP destination: {}", extension_target.display()));

        if let Some(target) = &native_target {
            log.line(&format!("Native destination: {}", target.display()));
        }

        wait_for_adobe_apps_to_close(log)?;

        let mut replacements = Vec::new();

        replacements.push(Replacement::stage(
            "CEP extension",
            extension_target,
            &cep_files,
            None,
            log,
        )?);

        if let Some(target) = native_target {
            match Replacement::stage(
                "native plugin",
                target,
                &native_files,
                Some(NATIVE_PLUGIN_PREFIX),
                log,
            ) {
                Ok(replacement) => replacements.push(replacement),
                Err(error) => {
                    cleanup_staging(&replacements, log);
                    return Err(error);
                }
            }
        }

        // Recheck immediately before commit, after potentially lengthy writes.
        let running = match running_adobe_apps() {
            Ok(running) => running,
            Err(error) => {
                cleanup_staging(&replacements, log);
                return Err(error);
            }
        };

        if !running.is_empty() {
            cleanup_staging(&replacements, log);
            return Err(format!(
                "Adobe applications started during staging: {}. \
                 Close them and rerun setup. Existing installations were not replaced.",
                running.join(", ")
            )
            .into());
        }

        let mut commit_error = None;

        for replacement in &mut replacements {
            if let Err(error) = replacement.commit(log) {
                commit_error = Some(error);
                break;
            }
        }

        if let Some(error) = commit_error {
            let mut rollback_errors = Vec::new();

            for replacement in replacements.iter_mut().rev() {
                if let Err(rollback_error) = replacement.rollback(log) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }

            cleanup_staging(&replacements, log);

            return Err(format!(
                "installation commit failed: {error}. {}",
                if rollback_errors.is_empty() {
                    "Previous installation directories were restored.".to_owned()
                } else {
                    format!(
                        "Rollback was incomplete: {}. \
                         Preserve the backup directories listed in the log.",
                        rollback_errors.join(" | ")
                    )
                }
            )
            .into());
        }

        // Both new installations are verified. Backup cleanup is non-fatal.
        for replacement in &replacements {
            replacement.finish(log);
        }

        if cfg!(feature = "development-unsigned") {
            let warnings = enable_unsigned_cep();

            if warnings.is_empty() {
                println!("\nDevelopment mode: unsigned CEP loading enabled for CSXS.11–CSXS.15.");
            } else {
                for warning in warnings {
                    log.line(&format!("REGISTRY WARNING: {warning}"));
                    eprintln!("Warning: {warning}");
                }
            }
        } else {
            // Do not claim the payload was signed merely because this is
            // not a development-unsigned build.
            println!("\nAdobe CEP debug-mode settings were not changed.");
            println!("CEP signature validation remains the responsibility of Adobe.");
        }

        if native_files.is_empty() {
            println!(
                "\nNo native plugin was packaged. Any previously installed native\n\
                 plugin was left unchanged; native Auto Color may be unavailable."
            );
            log.line("No native payload packaged; existing native installation preserved.");
        }

        Ok(())
    }

    /*
     * Windows named mutex: automatically released by the OS if setup dies.
     * Refuse installation if the global lock cannot be acquired.
     */

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            attributes: *mut c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> *mut c_void;

        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    // Win32 mutex FFI is required for cross-process installer locking.
    // These are the only unsafe blocks in this crate; suppress the
    // workspace-wide `unsafe_code` lint only for this narrow scope.

    #[allow(unsafe_code)]
    struct InstallerLock {
        handle: *mut c_void,
    }

    #[allow(unsafe_code)]
    impl InstallerLock {
        fn acquire() -> InstallResult<Self> {
            let name: Vec<u16> = "Global\\AutoCutStudio.Setup.InstallLock.v1\0"
                .encode_utf16()
                .collect();

            let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };

            if handle.is_null() {
                return Err(format!(
                    "could not open the installer lock: {}",
                    io::Error::last_os_error()
                )
                .into());
            }

            let status = unsafe { WaitForSingleObject(handle, 0) };

            match status {
                0x0000_0000 | 0x0000_0080 => Ok(Self { handle }),
                0x0000_0102 => {
                    unsafe {
                        CloseHandle(handle);
                    }
                    Err("another AutoCut Studio installer is already running".into())
                }
                _ => {
                    let error = io::Error::last_os_error();
                    unsafe {
                        CloseHandle(handle);
                    }
                    Err(format!("could not acquire the installer lock: {error}").into())
                }
            }
        }
    }

    #[allow(unsafe_code)]
    impl Drop for InstallerLock {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.handle);
                CloseHandle(self.handle);
            }
        }
    }

    /*
     * Path and payload validation.
     */

    fn required_absolute_env_path(name: &str) -> InstallResult<PathBuf> {
        let value = env::var_os(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("%{name}% is missing or empty"))?;

        let path = PathBuf::from(value);

        if !path.is_absolute() {
            return Err(format!("%{name}% must be an absolute path").into());
        }

        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err(format!("%{name}% contains non-normal path components").into());
        }

        Ok(path)
    }

    fn target_extension_dir() -> InstallResult<PathBuf> {
        Ok(required_absolute_env_path("APPDATA")?
            .join("Adobe")
            .join("CEP")
            .join("extensions")
            .join(EXTENSION_ID))
    }

    fn native_plugin_dir() -> InstallResult<PathBuf> {
        // ProgramW6432 points to the 64-bit installation directory even when
        // this installer is a 32-bit process on 64-bit Windows.
        let program_files = if env::var_os("ProgramW6432").is_some() {
            required_absolute_env_path("ProgramW6432")?
        } else {
            required_absolute_env_path("ProgramFiles")?
        };

        Ok(program_files
            .join("Adobe")
            .join("Common")
            .join("Plug-ins")
            .join("7.0")
            .join("MediaCore")
            .join("AutoCutStudio"))
    }

    fn validate_target_name(path: &Path, expected: &str) -> InstallResult<()> {
        if !path.is_absolute() || path.file_name().and_then(|name| name.to_str()) != Some(expected)
        {
            return Err(format!("unexpected installation destination: {}", path.display()).into());
        }

        ensure_no_reparse_ancestors(path)
    }

    fn metadata_if_present(path: &Path) -> io::Result<Option<fs::Metadata>> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn reject_reparse(path: &Path, metadata: &fs::Metadata) -> InstallResult<()> {
        if metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(format!(
                "refusing to operate through a symlink, junction, or reparse point: {}",
                path.display()
            )
            .into());
        }

        Ok(())
    }

    fn ensure_no_reparse_ancestors(path: &Path) -> InstallResult<()> {
        for ancestor in path.ancestors() {
            if let Some(metadata) = metadata_if_present(ancestor)? {
                reject_reparse(ancestor, &metadata)?;
            }
        }

        Ok(())
    }

    fn ensure_directory(path: &Path) -> InstallResult<()> {
        ensure_no_reparse_ancestors(path)?;
        fs::create_dir_all(path)?;
        ensure_no_reparse_ancestors(path)?;

        if !fs::symlink_metadata(path)?.is_dir() {
            return Err(format!("not a directory: {}", path.display()).into());
        }

        Ok(())
    }

    fn validate_relative_path(value: &str) -> InstallResult<()> {
        autocut_studio_setup::payload::validate_relative_path(value)?;
        validate_path_safety(value)
    }

    /// Validates path safety (traversal, device names, Windows characters)
    /// without checking the allowlist. Used for prefix-stripped paths during
    /// staging where the full path was already allowlist-validated.
    fn validate_path_safety(value: &str) -> InstallResult<()> {
        if value.is_empty() || value.contains('\\') {
            return Err(format!("invalid payload path: {value:?}").into());
        }

        for part in value.split('/') {
            if part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part.chars().any(|character| {
                    character.is_control()
                        || matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
                })
            {
                return Err(format!("unsafe Windows payload path: {value:?}").into());
            }

            let stem = part
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end_matches(' ')
                .to_uppercase();

            let numbered_device = stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .map(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
                .unwrap_or(false);

            if numbered_device
                || matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
                )
            {
                return Err(format!("reserved Windows name in payload: {value:?}").into());
            }
        }

        Ok(())
    }

    fn verify_embedded_payload() -> InstallResult<()> {
        if FILES.is_empty() {
            return Err(
                "this setup contains no embedded payload; build with embedded-payload enabled"
                    .into(),
            );
        }

        let mut entries = HashMap::with_capacity(FILES.len());
        let mut portable_names = HashSet::with_capacity(FILES.len());

        for file in FILES {
            validate_relative_path(file.relative_path)?;

            if entries.insert(file.relative_path, file).is_some()
                || !portable_names.insert(file.relative_path.to_lowercase())
            {
                return Err(format!(
                    "duplicate or case-colliding payload file: {}",
                    file.relative_path
                )
                .into());
            }
        }

        // Detect file/directory conflicts such as "assets" plus "assets/icon.png".
        for file in FILES {
            let parts = file.relative_path.split('/').collect::<Vec<_>>();

            for length in 1..parts.len() {
                let ancestor = parts[..length].join("/").to_lowercase();

                if portable_names.contains(&ancestor) {
                    return Err(format!(
                        "payload file conflicts with a directory: {}",
                        file.relative_path
                    )
                    .into());
                }
            }
        }

        let manifest_file = entries
            .get(PAYLOAD_MANIFEST)
            .ok_or("embedded payload manifest is missing")?;

        let manifest: autocut_studio_setup::payload::PayloadManifest =
            serde_json::from_slice(manifest_file.bytes)?;

        if manifest.schema_version != 1 {
            return Err("unsupported embedded payload manifest schema".into());
        }

        for (relative, expected) in &manifest.files {
            validate_relative_path(relative)?;

            let file = entries
                .get(relative.as_str())
                .ok_or_else(|| format!("embedded file is missing: {relative}"))?;

            if file.bytes.len() as u64 != expected.bytes
                || autocut_studio_setup::payload::sha256(file.bytes) != expected.sha256
            {
                return Err(format!("embedded payload hash mismatch: {relative}").into());
            }
        }

        for file in FILES {
            // CEP signature metadata may be added after manifest generation.
            if file.relative_path != PAYLOAD_MANIFEST
                && !file.relative_path.starts_with("META-INF/")
                && !manifest.files.contains_key(file.relative_path)
            {
                return Err(format!(
                    "embedded file is not declared in the manifest: {}",
                    file.relative_path
                )
                .into());
            }
        }

        if !entries.contains_key("CSXS/manifest.xml") {
            return Err("CEP package is missing CSXS/manifest.xml".into());
        }

        Ok(())
    }

    /*
     * Application checks.
     */

    fn wait_for_adobe_apps_to_close(log: &mut InstallLog) -> InstallResult<()> {
        loop {
            // Fail closed when process inspection fails.
            let running = running_adobe_apps()?;

            if running.is_empty() {
                return Ok(());
            }

            let names = running.join(", ");
            log.line(&format!("Adobe applications still running: {names}"));

            if !io::stdin().is_terminal() {
                return Err(format!(
                    "close Adobe applications before unattended installation: {names}"
                )
                .into());
            }

            println!(
                "\nClose these applications before installation:\n{names}\n\n\
                 Press Enter to retry, or type Q and press Enter to cancel."
            );
            io::stdout().flush()?;

            let mut answer = String::new();

            if io::stdin().read_line(&mut answer)? == 0 || answer.trim().eq_ignore_ascii_case("q") {
                return Err("installation cancelled while Adobe applications were running".into());
            }
        }
    }

    fn tasklist_path() -> InstallResult<PathBuf> {
        let root = required_absolute_env_path("SystemRoot")?;

        // A 32-bit installer uses Sysnative to access the native system tools.
        let sysnative = root.join("Sysnative").join("tasklist.exe");

        let path = if cfg!(target_pointer_width = "32") && sysnative.is_file() {
            sysnative
        } else {
            root.join("System32").join("tasklist.exe")
        };

        ensure_no_reparse_ancestors(&path)?;

        if !path.is_file() {
            return Err(format!("tasklist.exe is unavailable: {}", path.display()).into());
        }

        Ok(path)
    }

    fn running_adobe_apps() -> InstallResult<Vec<String>> {
        const PROCESSES: &[&str] = &[
            "Adobe Premiere Pro.exe",
            "Adobe Media Encoder.exe",
            "AfterFX.exe",
            "aerender.exe",
            "Adobe Audition.exe",
            "dynamiclinkmanager.exe",
        ];

        let mut child = Command::new(tasklist_path()?)
            .args(["/FO", "CSV", "/NH"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("could not capture process-list output".into());
            }
        };

        // Read concurrently so a full pipe cannot deadlock the process scan.
        let reader = thread::spawn(move || {
            const LIMIT: u64 = 16 * 1024 * 1024;

            let mut buffer = Vec::new();
            let mut limited = stdout.take(LIMIT + 1);
            limited.read_to_end(&mut buffer)?;

            if buffer.len() as u64 > LIMIT {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "process-list output exceeded its size limit",
                ));
            }

            Ok::<_, io::Error>(buffer)
        });

        let started = Instant::now();

        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < PROCESS_SCAN_TIMEOUT => {
                    thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(
                        "process inspection timed out; no installation was performed".into(),
                    );
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(error.into());
                }
            }
        };

        let output = reader.join().map_err(|_| "process-list reader failed")??;

        if !status.success() {
            return Err(format!("tasklist exited with {status}").into());
        }

        // Executable names matched below are ASCII even when tasklist emits
        // localized fields in the system code page.
        let text = String::from_utf8_lossy(&output);
        let mut found = Vec::new();
        let mut parsed_rows = 0;

        for line in text.lines() {
            let Some(name) = first_csv_field(line) else {
                continue;
            };

            parsed_rows += 1;

            if let Some(process) = PROCESSES
                .iter()
                .find(|candidate| candidate.eq_ignore_ascii_case(&name))
            {
                if !found
                    .iter()
                    .any(|existing: &String| existing.eq_ignore_ascii_case(process))
                {
                    found.push((*process).to_owned());
                }
            }
        }

        if parsed_rows == 0 {
            return Err("process inspection returned no recognizable process rows".into());
        }

        Ok(found)
    }

    fn first_csv_field(line: &str) -> Option<String> {
        let mut characters = line.trim_start().chars();

        if characters.next()? != '"' {
            return None;
        }

        let mut field = String::new();
        let mut characters = characters.peekable();

        while let Some(character) = characters.next() {
            if character != '"' {
                field.push(character);
                continue;
            }

            if characters.peek() == Some(&'"') {
                characters.next();
                field.push('"');
            } else {
                return (characters.next() == Some(',')).then_some(field);
            }
        }

        None
    }

    /*
     * Verified directory replacement.
     */

    struct Replacement {
        label: &'static str,
        target: PathBuf,
        staging: PathBuf,
        backup: PathBuf,
        files: Vec<&'static FileEntry>,
        strip_prefix: Option<&'static str>,
        old_moved: bool,
        new_installed: bool,
    }

    impl Replacement {
        fn stage(
            label: &'static str,
            target: PathBuf,
            files: &[&'static FileEntry],
            strip_prefix: Option<&'static str>,
            log: &mut InstallLog,
        ) -> InstallResult<Self> {
            let parent = target.parent().ok_or("invalid installation target")?;
            ensure_directory(parent)?;
            validate_existing_tree(&target)?;

            let name = target
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("invalid installation directory name")?;

            let id = unique_id();
            let staging = parent.join(format!(".{name}.staging-{id}"));
            let backup = parent.join(format!(".{name}.backup-{id}"));

            if metadata_if_present(&staging)?.is_some() || metadata_if_present(&backup)?.is_some() {
                return Err("unexpected staging or backup path collision".into());
            }

            fs::create_dir(&staging)?;

            let replacement = Self {
                label,
                target,
                staging,
                backup,
                files: files.to_vec(),
                strip_prefix,
                old_moved: false,
                new_installed: false,
            };

            log.line(&format!(
                "STAGE {label}: target={} staging={} backup={}",
                replacement.target.display(),
                replacement.staging.display(),
                replacement.backup.display()
            ));
            log.sync();

            let result = replacement
                .write_staging()
                .and_then(|_| replacement.verify(&replacement.staging));

            if let Err(error) = result {
                if let Err(cleanup_error) = remove_owned_tree(&replacement.staging) {
                    log.line(&format!(
                        "Staging cleanup failed: {}: {cleanup_error}",
                        replacement.staging.display()
                    ));
                }

                return Err(format!("{label} staging failed: {error}").into());
            }

            Ok(replacement)
        }

        fn relative_path<'a>(&self, file: &'a FileEntry) -> InstallResult<&'a str> {
            match self.strip_prefix {
                Some(prefix) => file
                    .relative_path
                    .strip_prefix(prefix)
                    .ok_or_else(|| "native payload path has an invalid prefix".into()),
                None => Ok(file.relative_path),
            }
        }

        fn write_staging(&self) -> InstallResult<()> {
            for file in &self.files {
                let relative = self.relative_path(file)?;
                validate_path_safety(relative)?;

                let path = self.staging.join(relative);
                let parent = path.parent().ok_or("invalid staged file path")?;
                ensure_directory(parent)?;
                ensure_no_reparse_ancestors(&path)?;

                let mut destination = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)?;

                destination.write_all(file.bytes)?;
                destination.sync_all()?;
            }

            Ok(())
        }

        fn verify(&self, directory: &Path) -> InstallResult<()> {
            ensure_no_reparse_ancestors(directory)?;

            for file in &self.files {
                let path = directory.join(self.relative_path(file)?);
                verify_file(&path, file.bytes)?;
            }

            Ok(())
        }

        fn commit(&mut self, log: &mut InstallLog) -> InstallResult<()> {
            validate_existing_tree(&self.target)?;
            self.verify(&self.staging)?;

            if metadata_if_present(&self.backup)?.is_some() {
                return Err(
                    format!("backup path unexpectedly exists: {}", self.backup.display()).into(),
                );
            }

            log.line(&format!("COMMIT START: {}", self.label));
            log.sync();

            if metadata_if_present(&self.target)?.is_some() {
                fs::rename(&self.target, &self.backup)?;
                self.old_moved = true;

                log.line(&format!(
                    "Previous {} moved to {}",
                    self.label,
                    self.backup.display()
                ));
                log.sync();
            }

            fs::rename(&self.staging, &self.target)?;
            self.new_installed = true;

            self.verify(&self.target)?;

            log.line(&format!("COMMIT VERIFIED: {}", self.label));
            log.sync();
            Ok(())
        }

        fn rollback(&mut self, log: &mut InstallLog) -> InstallResult<()> {
            if self.new_installed {
                // Preserve the unsuccessful new tree for diagnosis. Do not
                // destroy it before restoring the previous version.
                let parent = self.target.parent().ok_or("invalid rollback target")?;
                let failed = parent.join(format!(".autocut-failed-{}", unique_id()));

                if metadata_if_present(&failed)?.is_some() {
                    return Err("rollback quarantine path unexpectedly exists".into());
                }

                ensure_no_reparse_ancestors(&self.target)?;
                fs::rename(&self.target, &failed)?;
                self.new_installed = false;

                log.line(&format!(
                    "Rolled-back new {} retained at {}",
                    self.label,
                    failed.display()
                ));
            }

            if self.old_moved {
                if metadata_if_present(&self.target)?.is_some() {
                    return Err(format!(
                        "cannot restore {} because its target is occupied; backup: {}",
                        self.label,
                        self.backup.display()
                    )
                    .into());
                }

                ensure_no_reparse_ancestors(&self.backup)?;
                fs::rename(&self.backup, &self.target)?;
                self.old_moved = false;

                log.line(&format!("RESTORED previous {}", self.label));
            }

            log.sync();
            Ok(())
        }

        fn finish(&self, log: &mut InstallLog) {
            if !self.old_moved {
                return;
            }

            match remove_owned_tree(&self.backup) {
                Ok(()) => log.line(&format!(
                    "Removed verified-upgrade backup: {}",
                    self.backup.display()
                )),
                Err(error) => {
                    let warning = format!(
                        "installation succeeded, but backup cleanup failed: {}: {error}",
                        self.backup.display()
                    );
                    log.line(&warning);
                    eprintln!("Warning: {warning}");
                }
            }
        }
    }

    fn verify_file(path: &Path, expected: &[u8]) -> InstallResult<()> {
        ensure_no_reparse_ancestors(path)?;

        let metadata = fs::symlink_metadata(path)?;
        reject_reparse(path, &metadata)?;

        if !metadata.is_file() || metadata.len() != expected.len() as u64 {
            return Err(format!("installed file type or size mismatch: {}", path.display()).into());
        }

        let mut file = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];

        loop {
            let count = file.read(&mut buffer)?;

            if count == 0 {
                break;
            }

            hasher.update(&buffer[..count]);
        }

        if hasher.finalize() != Sha256::digest(expected) {
            return Err(format!("installed file hash mismatch: {}", path.display()).into());
        }

        Ok(())
    }

    fn validate_existing_tree(path: &Path) -> InstallResult<()> {
        ensure_no_reparse_ancestors(path)?;

        if let Some(metadata) = metadata_if_present(path)? {
            if !metadata.is_dir() {
                return Err(
                    format!("installation target is not a directory: {}", path.display()).into(),
                );
            }

            validate_tree(path, 0)?;
        }

        Ok(())
    }

    fn validate_tree(path: &Path, depth: usize) -> InstallResult<()> {
        if depth > MAX_DIRECTORY_DEPTH {
            return Err(format!("directory nesting is too deep: {}", path.display()).into());
        }

        let metadata = fs::symlink_metadata(path)?;
        reject_reparse(path, &metadata)?;

        if metadata.is_dir() {
            for entry in fs::read_dir(path)? {
                validate_tree(&entry?.path(), depth + 1)?;
            }
        } else if !metadata.is_file() {
            return Err(format!("unsupported filesystem entry: {}", path.display()).into());
        }

        Ok(())
    }

    fn remove_owned_tree(path: &Path) -> InstallResult<()> {
        ensure_no_reparse_ancestors(path)?;

        if metadata_if_present(path)?.is_none() {
            return Ok(());
        }

        validate_tree(path, 0)?;
        fs::remove_dir_all(path)?;
        Ok(())
    }

    fn cleanup_staging(replacements: &[Replacement], log: &mut InstallLog) {
        for replacement in replacements {
            if let Err(error) = remove_owned_tree(&replacement.staging) {
                log.line(&format!(
                    "Staging cleanup warning: {}: {error}",
                    replacement.staging.display()
                ));
            }
        }
    }

    fn unique_id() -> String {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        format!(
            "{}-{time}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn enable_unsigned_cep() -> Vec<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut warnings = Vec::new();

        for version in 11..=15 {
            let path = format!("Software\\Adobe\\CSXS.{version}");

            match hkcu.create_subkey(&path) {
                Ok((key, _)) => {
                    if let Err(error) = key.set_value("PlayerDebugMode", &"1") {
                        warnings.push(format!("{path}: could not set PlayerDebugMode: {error}"));
                    }
                }
                Err(error) => {
                    warnings.push(format!("{path}: could not open or create key: {error}"));
                }
            }
        }

        warnings
    }

    /*
     * Per-run logs avoid truncating previous installation diagnostics.
     * A failed AppData log attempt falls back to the current user's temp dir.
     */

    pub fn write_emergency_log(message: &str) -> InstallResult<()> {
        let mut log = InstallLog::new()?;
        log.line(message);
        log.sync();
        Ok(())
    }

    struct InstallLog {
        path: PathBuf,
        file: File,
        write_failed: bool,
    }

    impl InstallLog {
        fn new() -> InstallResult<Self> {
            let mut candidates = Vec::new();

            if let Ok(appdata) = required_absolute_env_path("APPDATA") {
                candidates.push(appdata.join("AutoCutStudio").join("logs"));
            }

            candidates.push(env::temp_dir().join("AutoCutStudio").join("logs"));

            let mut failures = Vec::new();

            for directory in candidates {
                match Self::create_in(&directory) {
                    Ok(log) => return Ok(log),
                    Err(error) => failures.push(format!("{}: {error}", directory.display())),
                }
            }

            Err(format!(
                "could not create an installation log: {}",
                failures.join(" | ")
            )
            .into())
        }

        fn create_in(directory: &Path) -> InstallResult<Self> {
            ensure_directory(directory)?;

            let path = directory.join(format!("install-{}.log", unique_id()));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;

            let mut log = Self {
                path,
                file,
                write_failed: false,
            };

            log.line("==== AutoCut Studio installation log ====");
            Ok(log)
        }

        fn line(&mut self, message: &str) {
            let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f %:z");

            if let Err(error) = writeln!(self.file, "[{timestamp}] {message}") {
                if !self.write_failed {
                    let _ = writeln!(
                        io::stderr().lock(),
                        "Warning: installation log could not be written: {error}"
                    );
                    self.write_failed = true;
                }
            }
        }

        fn sync(&mut self) {
            if let Err(error) = self.file.flush().and_then(|_| self.file.sync_all()) {
                if !self.write_failed {
                    let _ = writeln!(
                        io::stderr().lock(),
                        "Warning: installation log could not be flushed: {error}"
                    );
                    self.write_failed = true;
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn extracts_tasklist_process_names() {
            assert_eq!(
                first_csv_field(r#""Adobe Premiere Pro.exe","1234","Console","1","100,000 K""#),
                Some("Adobe Premiere Pro.exe".to_owned())
            );
        }

        #[test]
        fn parses_escaped_csv_quotes() {
            assert_eq!(
                first_csv_field(r#""a""b.exe","123""#),
                Some("a\"b.exe".to_owned())
            );
        }

        #[test]
        fn rejects_unrecognized_process_rows() {
            assert_eq!(first_csv_field("ERROR: unavailable"), None);
            assert_eq!(first_csv_field("\"unterminated"), None);
        }

        #[test]
        fn accepts_portable_relative_paths() {
            assert!(validate_relative_path("CSXS/manifest.xml").is_ok());
            assert!(validate_relative_path("assets/fonts/Inter.woff2").is_ok());
        }

        #[test]
        fn rejects_unsafe_relative_paths() {
            for path in [
                "",
                "../outside",
                "assets/../outside",
                "assets//image.png",
                "C:/outside",
                "/absolute",
                "assets\\image.png",
                "file.txt:stream",
                "CON",
                "AUX.txt",
                "folder/LPT1.dll",
                "folder/name.",
                "folder/name ",
            ] {
                assert!(
                    validate_relative_path(path).is_err(),
                    "unexpectedly accepted {path:?}"
                );
            }
        }
    }
}
