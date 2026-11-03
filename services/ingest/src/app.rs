use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures::{StreamExt, TryStreamExt};
use object_store::{GetOptions, GetRange, MultipartUpload, ObjectStore, PutPayload, path::Path};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

use crate::{sniff, token};

const SNIFF_BYTES: usize = 4096;
const RECEIPT_TTL_S: u64 = 60 * 60;
/// Most object stores need parts of at least 5 MiB, except the last.
pub const DEFAULT_PART_BYTES: usize = 5 * 1024 * 1024;
/// Upper bound on remembered grant nonces; each lives only until its grant expires.
const MAX_REMEMBERED_GRANTS: usize = 200_000;

pub struct AppState {
    pub store: Arc<dyn ObjectStore>,
    /// Every object key starts with this prefix; tokens for other keys are refused.
    pub prefix: Path,
    pub secret: Vec<u8>,
    /// Hard cap, applied on top of the per-grant limit.
    pub max_bytes: u64,
    /// A client that sends nothing for this long is disconnected.
    pub idle: Duration,
    pub allowed_origins: Vec<HeaderValue>,
    pub part_bytes: usize,
    /// Nonces of grants already used, with their expiry; a grant uploads exactly one file.
    pub used_grants: Mutex<HashMap<String, u64>>,
}

impl AppState {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        prefix: Path,
        secret: Vec<u8>,
        max_bytes: u64,
        idle: Duration,
        allowed_origins: Vec<HeaderValue>,
    ) -> Self {
        Self {
            store,
            prefix,
            secret,
            max_bytes,
            idle,
            allowed_origins,
            part_bytes: DEFAULT_PART_BYTES,
            used_grants: Mutex::new(HashMap::new()),
        }
    }

    /// Records a grant as used. Returns false if it was used before or the table is full.
    fn claim_grant(&self, nonce: &str, exp: u64) -> Result<(), &'static str> {
        let mut used = self.used_grants.lock().unwrap_or_else(|p| p.into_inner());
        if used.len() >= MAX_REMEMBERED_GRANTS / 2 {
            let now = now_s();
            used.retain(|_, e| *e > now);
        }
        if used.len() >= MAX_REMEMBERED_GRANTS {
            return Err("busy");
        }
        if used.insert(nonce.to_string(), exp).is_some() {
            return Err("used");
        }
        Ok(())
    }

    fn key(&self, parts: &[&str]) -> Path {
        self.prefix
            .parts()
            .chain(parts.iter().map(|p| (*p).into()))
            .collect()
    }

    /// Splits `prefix/<area...>/ws/<uuid>/projects/<uuid>/<tail>/<uuid>` into its ids.
    fn parse(&self, key: &str, pending: bool) -> Option<(String, String, String)> {
        let path = Path::parse(key).ok()?;
        let rest: Vec<String> = path
            .prefix_match(&self.prefix)?
            .map(|p| p.as_ref().to_string())
            .collect();
        let ids = match (pending, rest.as_slice()) {
            (true, [p, w, ws, pr, project, id])
                if p == "pending" && w == "ws" && pr == "projects" =>
            {
                (ws, project, id)
            }
            (false, [w, ws, pr, project, u, id])
                if w == "ws" && pr == "projects" && u == "uploads" =>
            {
                (ws, project, id)
            }
            _ => return None,
        };
        [ids.0, ids.1, ids.2]
            .iter()
            .all(|s| Uuid::parse_str(s).is_ok())
            .then(|| (ids.0.clone(), ids.1.clone(), ids.2.clone()))
    }
}

#[derive(Deserialize)]
struct UploadGrant {
    ws: String,
    project: String,
    by: String,
    #[serde(rename = "maxBytes")]
    max_bytes: u64,
    exp: u64,
    nonce: String,
}

#[derive(Deserialize)]
struct KeyGrant {
    key: String,
}

#[derive(Deserialize)]
struct DownloadGrant {
    key: String,
    filename: String,
}

/// Signed by the web server for members who may view a file: it names the key and the type to serve it as.
#[derive(Deserialize)]
struct PreviewGrant {
    key: String,
    #[serde(rename = "type")]
    content_type: String,
}

#[derive(Serialize)]
struct Receipt<'a> {
    v: u8,
    kind: &'a str,
    ws: &'a str,
    project: &'a str,
    by: &'a str,
    #[serde(rename = "objectKey")]
    object_key: &'a str,
    sha256: &'a str,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    #[serde(rename = "contentType")]
    content_type: &'a str,
    filename: &'a str,
    exp: u64,
}

pub fn router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(state.allowed_origins.clone()))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("x-filename"),
            header::RANGE,
        ])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
        ])
        .max_age(Duration::from_secs(600));
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .route("/v1/uploads", post(upload))
        .route("/v1/objects", get(download))
        .route("/v1/preview", get(preview))
        // Server-to-server, called by the web service with one-minute tokens naming one key.
        .route("/v1/commit", post(commit))
        .route("/v1/delete", post(delete))
        // Uploads are streamed and limited by the grant, not buffered by axum.
        .layer(DefaultBodyLimit::disable())
        .layer(cors)
        .layer(tower::limit::ConcurrencyLimitLayer::new(64))
        .with_state(state)
}

fn problem(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
        Json(json!({ "error": message })),
    )
        .into_response()
}

fn unavailable() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "Storage is unavailable. Please try again shortly.",
    )
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// Keeps only the last path segment, drops control characters and caps the length.
fn clean_filename(raw: Option<&HeaderValue>) -> String {
    let decoded = raw
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let base = decoded.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(255).collect();
    if cleaned.trim().is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Writes parts in order and surfaces every storage error, so a failed write can be aborted
/// before anything is reported as stored.
struct PartWriter {
    upload: Box<dyn MultipartUpload>,
    buf: Vec<u8>,
    part_bytes: usize,
}

impl PartWriter {
    async fn write(&mut self, data: &[u8]) -> object_store::Result<()> {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= self.part_bytes {
            let rest = self.buf.split_off(self.part_bytes);
            let part = std::mem::replace(&mut self.buf, rest);
            self.upload.put_part(PutPayload::from(part)).await?;
        }
        Ok(())
    }

    async fn finish(&mut self) -> object_store::Result<()> {
        if !self.buf.is_empty() {
            let last = std::mem::take(&mut self.buf);
            self.upload.put_part(PutPayload::from(last)).await?;
        }
        self.upload.complete().await.map(|_| ())
    }

    async fn abort(&mut self) {
        if let Err(err) = self.upload.abort().await {
            tracing::warn!(%err, "could not abort upload; the pending sweeper will remove it");
        }
    }
}

async fn upload(State(st): State<Arc<AppState>>, headers: HeaderMap, body: Body) -> Response {
    let Some(grant) = bearer(&headers)
        .and_then(|t| token::verify::<UploadGrant>(&st.secret, t, "upload", now_s()))
    else {
        return problem(
            StatusCode::UNAUTHORIZED,
            "This upload link is missing, invalid or expired. Start the upload again.",
        );
    };
    if [&grant.ws, &grant.project, &grant.by]
        .iter()
        .any(|id| Uuid::parse_str(id).is_err())
        || grant.nonce.len() < 8
    {
        return problem(StatusCode::UNAUTHORIZED, "This upload link is not valid.");
    }
    let limit = grant.max_bytes.min(st.max_bytes);
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return problem(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("This file is larger than the {limit}-byte limit."),
        );
    }
    // Claimed before streaming, so two concurrent requests cannot both use one grant.
    match st.claim_grant(&grant.nonce, grant.exp) {
        Ok(()) => {}
        Err("used") => {
            return problem(
                StatusCode::CONFLICT,
                "This upload link was already used. Each file needs its own.",
            );
        }
        Err(_) => {
            return problem(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many uploads in progress. Please try again shortly.",
            );
        }
    }
    let filename = clean_filename(headers.get("x-filename"));
    let id = Uuid::new_v4().to_string();
    // Files land in the pending area; only the web service's commit makes them permanent.
    let key = st.key(&["pending", "ws", &grant.ws, "projects", &grant.project, &id]);

    let upload = match st.store.put_multipart(&key).await {
        Ok(m) => m,
        Err(err) => {
            tracing::error!(%err, "could not start upload");
            return unavailable();
        }
    };
    let mut writer = PartWriter {
        upload,
        buf: Vec::new(),
        part_bytes: st.part_bytes,
    };
    let mut hasher = Sha256::new();
    let mut head: Vec<u8> = Vec::with_capacity(SNIFF_BYTES);
    let mut content_type: Option<&'static str> = None;
    let mut total: u64 = 0;
    let mut stream = body.into_data_stream();
    let rejected_type = || {
        problem(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "This file type is not accepted. Upload images, audio, video, documents, archives or tabular data.",
        )
    };

    let failure = loop {
        let chunk = match tokio::time::timeout(st.idle, stream.next()).await {
            Err(_) => {
                break Some(problem(
                    StatusCode::REQUEST_TIMEOUT,
                    "The upload stalled. Please try again.",
                ));
            }
            Ok(None) => break None,
            Ok(Some(Err(_))) => {
                break Some(problem(
                    StatusCode::BAD_REQUEST,
                    "The upload was interrupted. Please try again.",
                ));
            }
            Ok(Some(Ok(chunk))) => chunk,
        };
        total += chunk.len() as u64;
        if total > limit {
            break Some(problem(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("This file is larger than the {limit}-byte limit."),
            ));
        }
        hasher.update(&chunk);
        if content_type.is_none() {
            let room = SNIFF_BYTES - head.len();
            head.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if head.len() >= SNIFF_BYTES {
                match sniff::classify(&head, &filename) {
                    Some(t) => content_type = Some(t),
                    None => break Some(rejected_type()),
                }
            }
        }
        if let Err(err) = writer.write(&chunk).await {
            tracing::error!(%err, "storage write failed");
            break Some(unavailable());
        }
    };
    let failure = failure.or_else(|| {
        if total == 0 {
            return Some(problem(StatusCode::BAD_REQUEST, "The file is empty."));
        }
        if content_type.is_none() {
            content_type = sniff::classify(&head, &filename);
            if content_type.is_none() {
                return Some(rejected_type());
            }
        }
        None
    });
    if let Some(response) = failure {
        writer.abort().await;
        return response;
    }
    if let Err(err) = writer.finish().await {
        tracing::error!(%err, "could not finish upload");
        writer.abort().await;
        return unavailable();
    }

    let sha256 = hex::encode(hasher.finalize());
    let content_type = content_type.unwrap_or("application/octet-stream");
    let object_key = key.to_string();
    let receipt = token::sign(
        &st.secret,
        &Receipt {
            v: 1,
            kind: "receipt",
            ws: &grant.ws,
            project: &grant.project,
            by: &grant.by,
            object_key: &object_key,
            sha256: &sha256,
            size_bytes: total,
            content_type,
            filename: &filename,
            exp: now_s() + RECEIPT_TTL_S,
        },
    );
    tracing::info!(ws = %grant.ws, project = %grant.project, size = total, %content_type, "upload stored (pending)");
    (
        StatusCode::CREATED,
        [(header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
        Json(json!({
            "receipt": receipt, "sha256": sha256, "sizeBytes": total, "contentType": content_type, "filename": filename,
        })),
    )
        .into_response()
}

/// Moves a pending upload to its permanent key. Idempotent: a retried commit returns the same key.
async fn commit(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(grant) =
        bearer(&headers).and_then(|t| token::verify::<KeyGrant>(&st.secret, t, "commit", now_s()))
    else {
        return problem(StatusCode::UNAUTHORIZED, "Invalid or expired commit token.");
    };
    let Some((ws, project, id)) = st.parse(&grant.key, true) else {
        return problem(StatusCode::BAD_REQUEST, "Not a pending upload key.");
    };
    let pending = st.key(&["pending", "ws", &ws, "projects", &project, &id]);
    let committed = st.key(&["ws", &ws, "projects", &project, "uploads", &id]);
    let done = || Json(json!({ "objectKey": committed.to_string() })).into_response();
    match st.store.rename(&pending, &committed).await {
        Ok(()) => done(),
        Err(object_store::Error::NotFound { .. }) => match st.store.head(&committed).await {
            Ok(_) => done(),
            Err(object_store::Error::NotFound { .. }) => {
                problem(StatusCode::NOT_FOUND, "No such pending upload.")
            }
            Err(err) => {
                tracing::error!(%err, "commit check failed");
                unavailable()
            }
        },
        Err(err) => {
            tracing::error!(%err, "commit failed");
            unavailable()
        }
    }
}

/// Deletes one pending or committed object. A missing object counts as deleted.
async fn delete(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(grant) =
        bearer(&headers).and_then(|t| token::verify::<KeyGrant>(&st.secret, t, "delete", now_s()))
    else {
        return problem(StatusCode::UNAUTHORIZED, "Invalid or expired delete token.");
    };
    if st.parse(&grant.key, false).is_none() && st.parse(&grant.key, true).is_none() {
        return problem(StatusCode::BAD_REQUEST, "Not an upload key.");
    }
    let Ok(key) = Path::parse(&grant.key) else {
        return problem(StatusCode::BAD_REQUEST, "Not an upload key.");
    };
    match st.store.delete(&key).await {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => {
            Json(json!({ "ok": true })).into_response()
        }
        Err(err) => {
            tracing::error!(%err, "delete failed");
            unavailable()
        }
    }
}

/// Removes pending uploads older than `max_age`: files that were received but never committed.
pub async fn sweep_pending(st: &AppState, max_age: Duration) -> object_store::Result<usize> {
    let cutoff = SystemTime::now() - max_age;
    let pending = st.key(&["pending"]);
    let stale: Vec<Path> = st
        .store
        .list(Some(&pending))
        .try_filter(|meta| futures::future::ready(SystemTime::from(meta.last_modified) < cutoff))
        .map_ok(|meta| meta.location)
        .try_collect()
        .await?;
    for key in &stale {
        match st.store.delete(key).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(stale.len())
}

#[derive(Deserialize)]
struct DownloadQuery {
    token: String,
}

async fn download(State(st): State<Arc<AppState>>, Query(q): Query<DownloadQuery>) -> Response {
    let Some(grant) = token::verify::<DownloadGrant>(&st.secret, &q.token, "download", now_s())
    else {
        return problem(
            StatusCode::UNAUTHORIZED,
            "This download link is invalid or has expired.",
        );
    };
    // Only committed uploads can be downloaded.
    if st.parse(&grant.key, false).is_none() {
        return problem(StatusCode::NOT_FOUND, "Not found.");
    }
    let Ok(key) = Path::parse(&grant.key) else {
        return problem(StatusCode::BAD_REQUEST, "This download link is not valid.");
    };
    let result = match st.store.get(&key).await {
        Ok(r) => r,
        Err(object_store::Error::NotFound { .. }) => {
            return problem(StatusCode::NOT_FOUND, "Not found.");
        }
        Err(err) => {
            tracing::error!(%err, "download failed");
            return unavailable();
        }
    };
    let size = result.meta.size;
    let disposition = format!(
        "attachment; filename*=UTF-8''{}",
        utf8_percent_encode(&grant.filename, NON_ALPHANUMERIC)
    );
    let mut response = Body::from_stream(result.into_stream()).into_response();
    let h = response.headers_mut();
    // Always a download, never rendered: the content was supplied by a customer.
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    response
}

/// Types a preview link may be served as. Media are rendered by the browser; text is shown as plain text.
/// SVG and HTML never get here: ingest refuses them at upload.
fn previewable(content_type: &str) -> bool {
    let media = ["image/", "audio/", "video/"]
        .iter()
        .any(|p| content_type.starts_with(p))
        && content_type != "image/svg+xml"
        && content_type
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/.+-".contains(&b));
    media || content_type == "text/plain; charset=utf-8"
}

/// Parses a single `bytes=` range. Multiple ranges are not supported and fall back to the whole object.
fn parse_range(value: &str) -> Option<GetRange> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    match (start.trim(), end.trim()) {
        ("", n) => n.parse().ok().filter(|n| *n > 0).map(GetRange::Suffix),
        (a, "") => a.parse().ok().map(GetRange::Offset),
        (a, b) => {
            let (a, b): (u64, u64) = (a.parse().ok()?, b.parse().ok()?);
            (b >= a).then(|| GetRange::Bounded(a..b + 1))
        }
    }
}

async fn preview(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> Response {
    let Some(grant) = token::verify::<PreviewGrant>(&st.secret, &q.token, "preview", now_s())
    else {
        return problem(
            StatusCode::UNAUTHORIZED,
            "This preview link is invalid or has expired.",
        );
    };
    if !previewable(&grant.content_type) || st.parse(&grant.key, false).is_none() {
        return problem(StatusCode::NOT_FOUND, "Not found.");
    }
    let Ok(key) = Path::parse(&grant.key) else {
        return problem(StatusCode::BAD_REQUEST, "This preview link is not valid.");
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);
    let partial = range.is_some();
    let result = match st
        .store
        .get_opts(
            &key,
            GetOptions {
                range,
                ..Default::default()
            },
        )
        .await
    {
        Ok(r) => r,
        Err(object_store::Error::NotFound { .. }) => {
            return problem(StatusCode::NOT_FOUND, "Not found.");
        }
        Err(err) if partial => {
            tracing::warn!(%err, "preview range rejected");
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response
                .headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return response;
        }
        Err(err) => {
            tracing::error!(%err, "preview failed");
            return unavailable();
        }
    };
    let total = result.meta.size;
    let served = result.range.clone();
    let mut response = Body::from_stream(result.into_stream()).into_response();
    if partial {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    let h = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&grant.content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // Rendered inline but inert: no scripts, no plugins, no sniffing into another type.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=600"),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(served.end - served.start),
    );
    if partial {
        let value = format!(
            "bytes {}-{}/{}",
            served.start,
            served.end.saturating_sub(1),
            total
        );
        if let Ok(v) = HeaderValue::from_str(&value) {
            h.insert(header::CONTENT_RANGE, v);
        }
    }
    response
}

#[cfg(test)]
mod preview_tests {
    use super::{parse_range, previewable};
    use object_store::GetRange;

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_range("bytes=0-99"), Some(GetRange::Bounded(0..100)));
        assert_eq!(parse_range("bytes=100-"), Some(GetRange::Offset(100)));
        assert_eq!(parse_range("bytes=-500"), Some(GetRange::Suffix(500)));
        assert_eq!(parse_range("bytes=5-1"), None);
        assert_eq!(parse_range("bytes=0-1,4-5"), None);
        assert_eq!(parse_range("items=0-1"), None);
    }

    #[test]
    fn only_inert_types_are_previewable() {
        assert!(previewable("image/png"));
        assert!(previewable("video/mp4"));
        assert!(previewable("text/plain; charset=utf-8"));
        assert!(!previewable("image/svg+xml"));
        assert!(!previewable("text/html"));
        assert!(!previewable("application/pdf"));
        assert!(!previewable("video/mp4\r\nx: y"));
    }
}
