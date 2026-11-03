use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures::StreamExt;
use object_store::{ObjectStore, WriteMultipart, path::Path};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

use crate::{sniff, token};

const SNIFF_BYTES: usize = 4096;
const RECEIPT_TTL_S: u64 = 60 * 60;

pub struct AppState {
    pub store: Arc<dyn ObjectStore>,
    /// Every object key starts with this prefix; download tokens for other keys are refused.
    pub prefix: Path,
    pub secret: Vec<u8>,
    /// Hard cap, applied on top of the per-grant limit.
    pub max_bytes: u64,
    /// A client that sends nothing for this long is disconnected.
    pub idle: Duration,
    pub allowed_origins: Vec<HeaderValue>,
}

#[derive(Deserialize)]
struct UploadGrant {
    ws: String,
    project: String,
    by: String,
    #[serde(rename = "maxBytes")]
    max_bytes: u64,
}

#[derive(Deserialize)]
struct DownloadGrant {
    key: String,
    filename: String,
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
        ])
        .max_age(Duration::from_secs(600));
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .route("/v1/uploads", post(upload))
        .route("/v1/objects", get(download))
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

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

async fn upload(State(st): State<Arc<AppState>>, headers: HeaderMap, body: Body) -> Response {
    let Some(grant) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
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
    let filename = clean_filename(headers.get("x-filename"));
    let id = Uuid::new_v4().to_string();
    let key: Path = st
        .prefix
        .parts()
        .chain(
            [
                "ws",
                grant.ws.as_str(),
                "projects",
                grant.project.as_str(),
                "uploads",
                id.as_str(),
            ]
            .map(Into::into),
        )
        .collect();

    let multipart = match st.store.put_multipart(&key).await {
        Ok(m) => m,
        Err(err) => {
            tracing::error!(%err, "could not start upload");
            return problem(
                StatusCode::SERVICE_UNAVAILABLE,
                "Storage is unavailable. Please try again shortly.",
            );
        }
    };
    let mut writer = WriteMultipart::new(multipart);
    let mut hasher = Sha256::new();
    let mut head: Vec<u8> = Vec::with_capacity(SNIFF_BYTES);
    let mut content_type: Option<&'static str> = None;
    let mut total: u64 = 0;
    let mut stream = body.into_data_stream();

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
                    None => {
                        break Some(problem(
                            StatusCode::UNSUPPORTED_MEDIA_TYPE,
                            "This file type is not accepted. Upload images, audio, video, documents, archives or tabular data.",
                        ));
                    }
                }
            }
        }
        writer.wait_for_capacity(8).await.ok();
        writer.put(chunk);
    };
    let failure = failure.or_else(|| {
        if total == 0 {
            return Some(problem(StatusCode::BAD_REQUEST, "The file is empty."));
        }
        if content_type.is_none() {
            content_type = sniff::classify(&head, &filename);
            if content_type.is_none() {
                return Some(problem(StatusCode::UNSUPPORTED_MEDIA_TYPE, "This file type is not accepted. Upload images, audio, video, documents, archives or tabular data."));
            }
        }
        None
    });
    if let Some(response) = failure {
        if let Err(err) = writer.abort().await {
            tracing::warn!(%err, "could not abort rejected upload");
        }
        return response;
    }
    if let Err(err) = writer.finish().await {
        tracing::error!(%err, "could not finish upload");
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "Storage is unavailable. Please try again shortly.",
        );
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
    tracing::info!(ws = %grant.ws, project = %grant.project, size = total, %content_type, "upload stored");
    (StatusCode::CREATED, [(header::X_CONTENT_TYPE_OPTIONS, "nosniff")], Json(json!({
        "receipt": receipt, "sha256": sha256, "sizeBytes": total, "contentType": content_type, "filename": filename,
    })))
        .into_response()
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
    let Ok(key) = Path::parse(&grant.key) else {
        return problem(StatusCode::BAD_REQUEST, "This download link is not valid.");
    };
    if key.prefix_match(&st.prefix).is_none() {
        return problem(StatusCode::NOT_FOUND, "Not found.");
    }
    let result = match st.store.get(&key).await {
        Ok(r) => r,
        Err(object_store::Error::NotFound { .. }) => {
            return problem(StatusCode::NOT_FOUND, "Not found.");
        }
        Err(err) => {
            tracing::error!(%err, "download failed");
            return problem(
                StatusCode::SERVICE_UNAVAILABLE,
                "Storage is unavailable. Please try again shortly.",
            );
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
