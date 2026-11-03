use std::{sync::Arc, time::Duration};

use axum::http::HeaderValue;
use object_store::{ObjectStore, path::Path};
use url::Url;

use crate::app::AppState;

pub struct Config {
    pub bind: String,
    pub state: AppState,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Reads INGEST_* variables. Any missing or unsafe value stops startup with a message instead of running half-configured.
pub fn from_env() -> Result<Config, String> {
    let secret = env("INGEST_SHARED_SECRET").ok_or(
        "INGEST_SHARED_SECRET is required (32+ characters, same value as the web service)",
    )?;
    if secret.len() < 32 {
        return Err("INGEST_SHARED_SECRET must be at least 32 characters".into());
    }
    let storage = env("INGEST_STORAGE").ok_or(
        "INGEST_STORAGE is required, e.g. file:///var/lib/valcairn/objects or s3://bucket/prefix",
    )?;
    let url = Url::parse(&storage).map_err(|e| format!("INGEST_STORAGE is not a URL: {e}"))?;
    let (store, prefix) = open_store(&url)?;
    let origins = env("INGEST_ALLOWED_ORIGINS").ok_or(
        "INGEST_ALLOWED_ORIGINS is required: the web origin(s) allowed to upload, comma-separated",
    )?;
    let allowed_origins = origins
        .split(',')
        .map(|o| o.trim())
        .filter(|o| !o.is_empty())
        .map(|o| {
            HeaderValue::from_str(o)
                .map_err(|_| format!("INGEST_ALLOWED_ORIGINS has an invalid origin: {o}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let max_bytes = env("INGEST_MAX_BYTES")
        .map(|v| {
            v.parse::<u64>()
                .map_err(|_| "INGEST_MAX_BYTES must be a number of bytes")
        })
        .transpose()?
        .unwrap_or(200 * 1024 * 1024);
    let idle = env("INGEST_IDLE_SECONDS")
        .map(|v| {
            v.parse::<u64>()
                .map_err(|_| "INGEST_IDLE_SECONDS must be a number")
        })
        .transpose()?
        .unwrap_or(60);
    Ok(Config {
        bind: env("INGEST_BIND").unwrap_or_else(|| "127.0.0.1:4100".into()),
        state: AppState {
            store,
            prefix,
            secret: secret.into_bytes(),
            max_bytes,
            idle: Duration::from_secs(idle),
            allowed_origins,
        },
    })
}

fn open_store(url: &Url) -> Result<(Arc<dyn ObjectStore>, Path), String> {
    match url.scheme() {
        "file" => {
            let dir = url
                .to_file_path()
                .map_err(|_| "INGEST_STORAGE file:// URL must be an absolute path")?;
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            let store = object_store::local::LocalFileSystem::new_with_prefix(&dir)
                .map_err(|e| e.to_string())?;
            Ok((Arc::new(store), Path::default()))
        }
        "s3" => {
            // Credentials, region and (for MinIO/R2) AWS_ENDPOINT come from the standard AWS_* environment variables.
            let options = std::env::vars()
                .filter(|(k, _)| k.starts_with("AWS_"))
                .map(|(k, v)| (k.to_ascii_lowercase(), v));
            let (store, prefix) =
                object_store::parse_url_opts(url, options).map_err(|e| e.to_string())?;
            Ok((Arc::from(store), prefix))
        }
        other => Err(format!(
            "INGEST_STORAGE scheme {other}:// is not supported; use file:// or s3://"
        )),
    }
}
