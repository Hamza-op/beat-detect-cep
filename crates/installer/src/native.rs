use std::fs;
use std::path::Path;

pub fn install_release_plugin(source: &Path, target_dir: &Path) -> Result<(), String> {
    if source.extension().and_then(|e| e.to_str()) != Some("aex") {
        return Err("only release .aex files may be installed".into());
    }
    fs::create_dir_all(target_dir).map_err(|e| e.to_string())?;
    fs::copy(
        source,
        target_dir.join(source.file_name().ok_or("plugin has no filename")?),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
