use std::fs;
use std::path::Path;

pub fn replace_directory_transactionally<Write, Verify>(
    target: &Path,
    write_staged: Write,
    verify: Verify,
) -> Result<(), String>
where
    Write: FnOnce(&Path) -> Result<(), String>,
    Verify: Fn(&Path) -> Result<(), String>,
{
    let parent = target.parent().ok_or("target has no parent")?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("target has no valid folder name")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let staging = parent.join(format!(".{name}.staging-{}", std::process::id()));
    let backup = parent.join(format!(".{name}.backup"));
    remove_directory_if_present(&staging)?;

    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    if let Err(error) = write_staged(&staging).and_then(|_| verify(&staging)) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    remove_directory_if_present(&backup)?;
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!("could not preserve the previous installation: {error}")
        })?;
    }

    if let Err(error) = fs::rename(&staging, target) {
        let rollback = restore_backup(target, &backup);
        return Err(with_rollback(
            format!("could not activate the new installation: {error}"),
            rollback,
        ));
    }

    if let Err(error) = verify(target) {
        let rollback = restore_backup(target, &backup);
        return Err(with_rollback(
            format!("activated installation failed verification: {error}"),
            rollback,
        ));
    }

    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|error| {
            format!("new installation is valid, but old-version cleanup failed: {error}")
        })?;
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn restore_backup(target: &Path, backup: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    if backup.exists() {
        fs::rename(backup, target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn with_rollback(message: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => message,
        Err(error) => {
            format!("{message}; restoring the previous installation also failed: {error}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "acs-native-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    #[test]
    fn verified_upgrade_removes_stale_files() {
        let root = test_root("upgrade");
        let _ = fs::remove_dir_all(&root);
        let target = root.join("AutoCutStudio");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.aex"), b"old").unwrap();

        replace_directory_transactionally(
            &target,
            |staged| {
                fs::write(staged.join("AutoCutColorEngine.aex"), b"new")
                    .map_err(|error| error.to_string())
            },
            |candidate| {
                let bytes = fs::read(candidate.join("AutoCutColorEngine.aex"))
                    .map_err(|error| error.to_string())?;
                if bytes != b"new" {
                    return Err("plugin bytes did not match".into());
                }
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            fs::read(target.join("AutoCutColorEngine.aex")).unwrap(),
            b"new"
        );
        assert!(!target.join("old.aex").exists());
        assert!(!root.join(".AutoCutStudio.backup").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_failure_keeps_previous_plugin() {
        let root = test_root("stage-failure");
        let _ = fs::remove_dir_all(&root);
        let target = root.join("AutoCutStudio");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("AutoCutColorEngine.aex"), b"old").unwrap();

        let result = replace_directory_transactionally(
            &target,
            |_staged| Err("simulated write failure".into()),
            |_candidate| Ok(()),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(target.join("AutoCutColorEngine.aex")).unwrap(),
            b"old"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn verification_failure_keeps_previous_plugin() {
        let root = test_root("verify-failure");
        let _ = fs::remove_dir_all(&root);
        let target = root.join("AutoCutStudio");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("AutoCutColorEngine.aex"), b"old").unwrap();

        let result = replace_directory_transactionally(
            &target,
            |staged| {
                fs::write(staged.join("AutoCutColorEngine.aex"), b"bad")
                    .map_err(|error| error.to_string())
            },
            |_candidate| Err("simulated hash mismatch".into()),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(target.join("AutoCutColorEngine.aex")).unwrap(),
            b"old"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
