//! Decides what an uploaded file really is from its first bytes, never from the client's claim.
//! Only data formats are accepted; executables and anything a browser could run (HTML, SVG) are refused.

/// Returns the content type to record, or `None` when the file is not an accepted data format.
pub fn classify(head: &[u8], filename: &str) -> Option<&'static str> {
    if head.starts_with(b"PAR1") {
        return Some("application/vnd.apache.parquet");
    }
    if let Some(kind) = infer::get(head) {
        let mime = kind.mime_type();
        return ALLOWED_BINARY
            .iter()
            .copied()
            .find(|m| *m == mime)
            .or_else(|| {
                // Image, audio and video families are data as long as they are not scriptable (SVG is text, so it never lands here).
                ["image/", "audio/", "video/"]
                    .iter()
                    .any(|p| mime.starts_with(p))
                    .then_some(mime)
            });
    }
    text_type(head, filename)
}

const ALLOWED_BINARY: &[&str] = &[
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/x-bzip2",
    "application/zstd",
];

fn text_type(head: &[u8], filename: &str) -> Option<&'static str> {
    // Text must be valid UTF-8 (a cut multi-byte character at the end of the sample is fine) and contain no NUL bytes.
    let valid = match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    };
    if !valid || head.contains(&0) {
        return None;
    }
    let lower = filename.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    let trimmed = String::from_utf8_lossy(head)
        .trim_start()
        .to_ascii_lowercase();
    if trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<svg")
        || trimmed.starts_with("<?xml")
    {
        return None;
    }
    Some(match ext {
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "jsonl" | "ndjson" => "application/x-ndjson",
        "md" => "text/markdown",
        "srt" | "vtt" => "text/plain",
        "txt" | "" => "text/plain",
        _ => "text/plain",
    })
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn accepts_data_formats_by_content() {
        let png = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D,
        ];
        assert_eq!(classify(&png, "photo.txt"), Some("image/png"));
        assert_eq!(classify(b"%PDF-1.7\n", "a.pdf"), Some("application/pdf"));
        assert_eq!(
            classify(b"PAR1\x15\x04", "t.parquet"),
            Some("application/vnd.apache.parquet")
        );
        assert_eq!(
            classify(b"id,label\n1,damaged\n", "labels.csv"),
            Some("text/csv")
        );
        assert_eq!(
            classify(b"{\"a\":1}\n{\"a\":2}\n", "rows.jsonl"),
            Some("application/x-ndjson")
        );
    }

    #[test]
    fn refuses_executables_and_scriptable_documents() {
        assert_eq!(classify(b"MZ\x90\x00\x03\x00\x00\x00", "setup.png"), None);
        assert_eq!(
            classify(&[0x7f, b'E', b'L', b'F', 2, 1, 1, 0], "data.csv"),
            None
        );
        assert_eq!(
            classify(&[0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1], "model.bin"),
            None
        );
        assert_eq!(classify(b"<!DOCTYPE html><script>", "page.txt"), None);
        assert_eq!(classify(b"<svg onload=alert(1)>", "x.csv"), None);
        assert_eq!(classify(b"bin\x00ary", "x.csv"), None);
    }
}
