pub const DEBUG_CSXS_VERSIONS: &[u8] = b"11,12,13";

#[cfg(windows)]
pub fn enable_unsigned_cep() -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn enable_unsigned_cep() -> Vec<String> {
    vec!["CEP debug registry configuration is available only on Windows".into()]
}
