use crate::payload::{copy_allowlisted_payload, verify_manifest, PayloadManifest};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct InstallTransaction {
    target: PathBuf,
    backup: Option<PathBuf>,
    manifest: PayloadManifest,
}

impl InstallTransaction {
    pub fn stage(source: &Path, target: &Path, manifest: &PayloadManifest) -> Result<Self, String> {
        let parent = target.parent().ok_or("target has no parent")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let staged = parent.join(format!(
            ".{}.staging-{}",
            target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("autocut"),
            std::process::id()
        ));
        if staged.exists() {
            fs::remove_dir_all(&staged).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
        copy_allowlisted_payload(source, &staged, manifest)?;
        Ok(Self {
            target: target.to_path_buf(),
            backup: Some(staged),
            manifest: manifest.clone(),
        })
    }

    pub fn commit(mut self) -> Result<(), String> {
        let staged = self.backup.take().ok_or("transaction already committed")?;
        let backup = self.target.with_extension("backup");
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(|e| e.to_string())?;
        }
        if self.target.exists() {
            fs::rename(&self.target, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&staged, &self.target) {
            if backup.exists() && !self.target.exists() {
                let _ = fs::rename(&backup, &self.target);
            }
            return Err(error.to_string());
        }
        if let Err(error) = verify_manifest(&self.target, &self.manifest) {
            let _ = fs::remove_dir_all(&self.target);
            if backup.exists() {
                let _ = fs::rename(&backup, &self.target);
            }
            return Err(error);
        }
        if backup.exists() {
            fs::remove_dir_all(backup).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{collect_manifest, validate_relative_path};
    use std::fs;

    #[test]
    fn rejects_traversal() {
        assert!(validate_relative_path("../outside.txt").is_err());
        assert!(validate_relative_path("CSXS/manifest.xml").is_ok());
    }

    #[test]
    fn upgrades_and_removes_stale_owned_files() {
        let root = std::env::temp_dir().join(format!("acs-installer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("source/CSXS")).unwrap();
        fs::write(root.join("source/CSXS/manifest.xml"), b"manifest").unwrap();
        fs::write(root.join("source/index.html"), b"index").unwrap();
        let manifest = collect_manifest(&root.join("source")).unwrap();
        fs::write(
            root.join("source/payload-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("obsolete.txt"), b"old").unwrap();
        let transaction =
            InstallTransaction::stage(&root.join("source"), &target, &manifest).unwrap();
        transaction.commit().unwrap();
        assert!(!target.join("obsolete.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fresh_install_replaces_only_owned_payload() {
        let root = std::env::temp_dir().join(format!("acs-installer-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("source/CSXS")).unwrap();
        fs::write(root.join("source/CSXS/manifest.xml"), b"manifest").unwrap();
        fs::write(root.join("source/index.html"), b"index").unwrap();
        let manifest = collect_manifest(&root.join("source")).unwrap();
        fs::write(
            root.join("source/payload-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let target = root.join("target");
        InstallTransaction::stage(&root.join("source"), &target, &manifest)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(target.join("index.html")).unwrap(), b"index");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_failure_preserves_previous_install() {
        let root =
            std::env::temp_dir().join(format!("acs-installer-rollback-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("source/CSXS")).unwrap();
        fs::write(root.join("source/CSXS/manifest.xml"), b"manifest").unwrap();
        fs::write(root.join("source/index.html"), b"index").unwrap();
        let manifest = collect_manifest(&root.join("source")).unwrap();
        fs::write(
            root.join("source/payload-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"previous").unwrap();
        let mut invalid = manifest.clone();
        invalid.files.get_mut("index.html").unwrap().sha256 = "00".repeat(32);
        let result = InstallTransaction::stage(&root.join("source"), &target, &invalid);
        assert!(result.is_err());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"previous");
        let _ = fs::remove_dir_all(&root);
    }
}
