use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
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
