use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const EXTENSION_ID: &str = "com.beatdetect.spikemarker";

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let package_dir = manifest_dir
        .parent()
        .expect("installer crate has a parent directory")
        .join("dist")
        .join(EXTENSION_ID);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let generated_path = out_dir.join("generated_files.rs");

    if !package_dir.exists() {
        write_compile_error(
            &generated_path,
            "extension package missing; run scripts/build-setup-exe.ps1",
        )
        .expect("write generated installer source");
        return;
    }

    println!("cargo:rerun-if-changed={}", package_dir.display());

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
