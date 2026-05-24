use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const EXTENSION_ID: &str = "com.autocutstudio.panel";

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let package_dir = manifest_dir
        .parent()
        .expect("installer crate has a parent directory")
        .join("dist")
        .join(EXTENSION_ID);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let generated_path = out_dir.join("generated_files.rs");

    // Dynamic search and compilation of the UAC requestedExecutionLevel manifest
    if let Some(rc_path) = find_rc_exe() {
        let rc_file = manifest_dir.join("src").join("manifest.rc");
        let res_file = out_dir.join("manifest.res");

        let status = std::process::Command::new(rc_path)
            .arg("/fo")
            .arg(&res_file)
            .arg(&rc_file)
            .status();

        if let Ok(status) = status {
            if status.success() {
                // Link the compiled .res file natively
                println!("cargo:rustc-link-arg={}", res_file.display());
            }
        }
    } else {
        // Fallback to UAC linker option if rc.exe is somehow not found
        println!("cargo:rustc-link-arg=/MANIFESTUAC:level='requireAdministrator'");
    }

    println!("cargo:rerun-if-changed={}", package_dir.display());
    if !package_dir.exists() {
        write_compile_error(
            &generated_path,
            "extension package missing; run scripts/build-setup-exe.ps1",
        )
        .expect("write generated installer source");
        return;
    }

    let mut files = Vec::new();
    collect_files(&package_dir, &mut files).expect("collect packaged extension files");
    files.sort();

    let mut generated = String::from("const FILES: &[FileEntry] = &[\n");
    for file in files {
        let relative_path = file
            .strip_prefix(&package_dir)
            .expect("packaged file is inside package dir")
            .to_string_lossy()
            .replace('\\', "/");
        let include_path = file.to_string_lossy().replace('\\', "/");
        generated.push_str(&format!(
            "    FileEntry {{ relative_path: r#\"{}\"#, bytes: include_bytes!(r#\"{}\"#) }},\n",
            relative_path, include_path
        ));
    }
    generated.push_str("];\n");

    fs::write(generated_path, generated).expect("write generated installer source");
}

fn find_rc_exe() -> Option<PathBuf> {
    let search_paths = [
        Path::new("D:\\Windows Kits\\10\\bin"),
        Path::new("C:\\Program Files (x86)\\Windows Kits\\10\\bin"),
    ];

    for base in &search_paths {
        if !base.exists() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let x64_rc = path.join("x64").join("rc.exe");
                    if x64_rc.exists() {
                        return Some(x64_rc);
                    }
                    let x86_rc = path.join("x86").join("rc.exe");
                    if x86_rc.exists() {
                        return Some(x86_rc);
                    }
                }
            }
        }
    }
    None
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files)?;
        } else if path.file_name().and_then(|name| name.to_str()) != Some(".gitkeep") {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(path);
        }
    }
    Ok(())
}

fn write_compile_error(path: &Path, message: &str) -> io::Result<()> {
    fs::write(path, format!("compile_error!(r#\"{}\"#);\n", message))
}
