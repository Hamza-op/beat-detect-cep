use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayloadFile {
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayloadManifest {
    pub schema_version: u32,
    pub files: BTreeMap<String, PayloadFile>,
}

pub const ALLOWLIST: &[&str] = &[
    "CSXS/manifest.xml",
    "index.html",
    "css/",
    "js/",
    "assets/fonts/",
    "jsx/host.jsx",
    "bin/beat_analyzer.exe",
    "native/MediaCore/AutoCutColorEngine.aex",
    "INSTALL.txt",
    "payload-manifest.json",
];

pub fn validate_relative_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if candidate.is_absolute() || path.contains('\\') || path.contains('\0') {
        return Err(format!("path is not a normalized relative path: {path}"));
    }
    for component in candidate.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("path traversal rejected: {path}"));
        }
    }
    if !ALLOWLIST
        .iter()
        .any(|prefix| path == *prefix || (prefix.ends_with('/') && path.starts_with(prefix)))
    {
        return Err(format!("path is not in the release allowlist: {path}"));
    }
    Ok(())
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn verify_manifest(root: &Path, manifest: &PayloadManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("unsupported payload manifest schema".into());
    }
    for (relative, expected) in &manifest.files {
        validate_relative_path(relative)?;
        let path = root.join(relative);
        let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if bytes.len() as u64 != expected.bytes || sha256(&bytes) != expected.sha256 {
            return Err(format!("payload hash mismatch: {relative}"));
        }
    }
    Ok(())
}

pub fn collect_manifest(root: &Path) -> Result<PayloadManifest, String> {
    let mut files = BTreeMap::new();
    collect_files(root, root, &mut files)?;
    Ok(PayloadManifest {
        schema_version: 1,
        files,
    })
}

fn collect_files(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, PayloadFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if relative == "payload-manifest.json" {
            continue;
        }
        validate_relative_path(&relative)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        files.insert(
            relative.clone(),
            PayloadFile {
                relative_path: relative,
                sha256: sha256(&bytes),
                bytes: bytes.len() as u64,
            },
        );
    }
    Ok(())
}

pub fn copy_allowlisted_payload(
    source: &Path,
    destination: &Path,
    manifest: &PayloadManifest,
) -> Result<(), String> {
    verify_manifest(source, manifest)?;
    for relative in manifest.files.keys() {
        validate_relative_path(relative)?;
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(source.join(relative), target).map_err(|e| e.to_string())?;
    }
    let manifest_file = source.join("payload-manifest.json");
    if manifest_file.exists() {
        fs::copy(&manifest_file, destination.join("payload-manifest.json"))
            .map_err(|e| e.to_string())?;
    }
    verify_manifest(destination, manifest)
}
