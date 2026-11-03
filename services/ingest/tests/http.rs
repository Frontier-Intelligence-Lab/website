use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode, header},
};
use futures::stream::BoxStream;
use http_body_util::BodyExt;
use object_store::{
    GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore,
    PutMultipartOptions, PutOptions, PutPayload, PutResult, UploadPart, local::LocalFileSystem,
    memory::InMemory, path::Path,
};
use serde_json::{Value, json};
use tower::ServiceExt;
use valcairn_ingest::{app, token};

const SECRET: &[u8] = b"test-secret-that-is-at-least-32-chars!!";
const WS: &str = "11111111-1111-4111-8111-111111111111";
const PROJECT: &str = "22222222-2222-4222-8222-222222222222";
const USER: &str = "33333333-3333-4333-8333-333333333333";
const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D', b'R',
];

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn state(store: Arc<dyn ObjectStore>, max_bytes: u64) -> Arc<app::AppState> {
    Arc::new(app::AppState::new(
        store,
        Path::default(),
        SECRET.to_vec(),
        max_bytes,
        Duration::from_secs(5),
        vec![HeaderValue::from_static("http://localhost:3000")],
    ))
}

fn on_disk(dir: &std::path::Path, max_bytes: u64) -> (axum::Router, Arc<app::AppState>) {
    let st = state(
        Arc::new(LocalFileSystem::new_with_prefix(dir).unwrap()),
        max_bytes,
    );
    (app::router(st.clone()), st)
}

fn grant(max_bytes: u64, exp: u64) -> String {
    token::sign(
        SECRET,
        &json!({ "v": 1, "kind": "upload", "ws": WS, "project": PROJECT, "by": USER, "maxBytes": max_bytes, "exp": exp, "nonce": uuid::Uuid::new_v4().to_string() }),
    )
}

fn key_token(kind: &str, key: &str) -> String {
    token::sign(
        SECRET,
        &json!({ "v": 1, "kind": kind, "key": key, "exp": now() + 60 }),
    )
}

async fn send(
    router: axum::Router,
    auth: Option<String>,
    filename: &str,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut req = Request::post("/v1/uploads").header("x-filename", filename);
    if let Some(t) = auth {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let res = router
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn call(router: axum::Router, path: &str, token: &str) -> (StatusCode, Value) {
    let req = Request::post(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get(router: axum::Router, url: &str) -> axum::response::Response {
    router
        .oneshot(Request::get(url).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[tokio::test]
async fn upload_lands_pending_and_becomes_downloadable_only_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (r, _) = on_disk(dir.path(), 1 << 20);
    let (status, body) = send(
        r.clone(),
        Some(grant(1 << 20, now() + 60)),
        "box%201.png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["contentType"], "image/png");
    assert_eq!(body["filename"], "box 1.png");

    let receipt: Value = token::verify(SECRET, body["receipt"].as_str().unwrap(), "receipt", now())
        .expect("receipt verifies");
    let pending = receipt["objectKey"].as_str().unwrap().to_string();
    assert!(
        pending.starts_with(&format!("pending/ws/{WS}/projects/{PROJECT}/")),
        "{pending}"
    );
    let dl = |key: &str| {
        format!(
            "/v1/objects?token={}",
            token::sign(
                SECRET,
                &json!({ "v": 1, "kind": "download", "key": key, "filename": "box 1.png", "exp": now() + 60 })
            )
        )
    };
    assert_eq!(
        get(r.clone(), &dl(&pending)).await.status(),
        StatusCode::NOT_FOUND,
        "pending files are not downloadable"
    );

    let (status, committed) = call(r.clone(), "/v1/commit", &key_token("commit", &pending)).await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    let key = committed["objectKey"].as_str().unwrap().to_string();
    assert!(key.starts_with(&format!("ws/{WS}/projects/{PROJECT}/uploads/")));
    // Retrying a commit is safe and returns the same key.
    assert_eq!(
        call(r.clone(), "/v1/commit", &key_token("commit", &pending))
            .await
            .1["objectKey"],
        key.as_str()
    );

    let res = get(r.clone(), &dl(&key)).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(
        res.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("box%201%2Epng")
    );
    assert_eq!(
        res.into_body().collect().await.unwrap().to_bytes().as_ref(),
        PNG
    );

    // Tokens are bound to their kind; a delete token for a committed key removes it, twice is fine.
    assert_eq!(
        call(r.clone(), "/v1/delete", &key_token("commit", &key))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(r.clone(), "/v1/delete", &key_token("delete", &key))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(r.clone(), "/v1/delete", &key_token("delete", &key))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        get(r.clone(), &dl(&key)).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            r.clone(),
            "/v1/delete",
            &key_token("delete", "../../etc/passwd")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(r, "/v1/commit", &key_token("commit", &key)).await.0,
        StatusCode::BAD_REQUEST,
        "only pending keys commit"
    );
}

#[tokio::test]
async fn a_grant_uploads_exactly_one_file() {
    let dir = tempfile::tempdir().unwrap();
    let (r, _) = on_disk(dir.path(), 1 << 20);
    let g = grant(1 << 20, now() + 60);
    assert_eq!(
        send(r.clone(), Some(g.clone()), "a.png", PNG.to_vec())
            .await
            .0,
        StatusCode::CREATED
    );
    let (status, body) = send(r.clone(), Some(g), "b.png", PNG.to_vec()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(walk(dir.path()).len(), 1);
}

#[tokio::test]
async fn refuses_missing_expired_or_forged_grants() {
    let dir = tempfile::tempdir().unwrap();
    let (r, _) = on_disk(dir.path(), 1 << 20);
    assert_eq!(
        send(r.clone(), None, "a.png", PNG.to_vec()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(
            r.clone(),
            Some(grant(1 << 20, now() - 1)),
            "a.png",
            PNG.to_vec()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let forged = token::sign(
        b"some-other-secret-that-is-32-chars-x",
        &json!({ "kind": "upload", "ws": WS, "project": PROJECT, "by": USER, "maxBytes": 10, "exp": now() + 60, "nonce": "abcdefgh" }),
    );
    assert_eq!(
        send(r.clone(), Some(forged), "a.png", PNG.to_vec()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let bad_ids = token::sign(
        SECRET,
        &json!({ "kind": "upload", "ws": "../../etc", "project": PROJECT, "by": USER, "maxBytes": 10, "exp": now() + 60, "nonce": "abcdefgh" }),
    );
    assert_eq!(
        send(r, Some(bad_ids), "a.png", PNG.to_vec()).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn enforces_size_limits_type_rules_and_leaves_no_rejected_files_behind() {
    let dir = tempfile::tempdir().unwrap();
    let (r, _) = on_disk(dir.path(), 64);
    let mut big = PNG.to_vec();
    big.resize(65, 0);
    let g = || Some(grant(1 << 20, now() + 60));
    // The server cap (64) wins over a larger grant.
    assert_eq!(
        send(r.clone(), g(), "big.png", big).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        send(
            r.clone(),
            g(),
            "setup.png",
            b"MZ\x90\x00\x03\x00\x00\x00".to_vec()
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        send(r.clone(), g(), "page.csv", b"<html><script>".to_vec())
            .await
            .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        send(r.clone(), g(), "empty.csv", Vec::new()).await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, body) = send(r, g(), "../../labels.csv", b"id,label\n1,ok\n".to_vec()).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["filename"], "labels.csv");
    assert_eq!(body["contentType"], "text/csv");
    let stored = walk(dir.path());
    assert_eq!(
        stored.len(),
        1,
        "only the accepted file remains: {stored:?}"
    );
}

#[tokio::test]
async fn the_sweeper_removes_uncommitted_uploads_but_keeps_committed_ones() {
    let dir = tempfile::tempdir().unwrap();
    let (r, st) = on_disk(dir.path(), 1 << 20);
    let first = send(
        r.clone(),
        Some(grant(1 << 20, now() + 60)),
        "keep.png",
        PNG.to_vec(),
    )
    .await
    .1;
    let pending: Value =
        token::verify(SECRET, first["receipt"].as_str().unwrap(), "receipt", now()).unwrap();
    call(
        r.clone(),
        "/v1/commit",
        &key_token("commit", pending["objectKey"].as_str().unwrap()),
    )
    .await;
    send(
        r,
        Some(grant(1 << 20, now() + 60)),
        "abandoned.png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(walk(dir.path()).len(), 2);
    assert_eq!(
        app::sweep_pending(&st, Duration::from_secs(3600))
            .await
            .unwrap(),
        0,
        "fresh pending files are kept"
    );
    assert_eq!(app::sweep_pending(&st, Duration::ZERO).await.unwrap(), 1);
    let left = walk(dir.path());
    assert_eq!(left.len(), 1);
    assert!(left[0].to_string_lossy().contains("/uploads/"));
}

// ---- Fault injection: a store whose writes fail. ----

#[derive(Debug, Clone, Copy)]
enum Fail {
    Part,
    Complete,
}

#[derive(Debug)]
struct FaultyStore {
    inner: InMemory,
    fail: Fail,
    aborted: Arc<AtomicBool>,
    parts: Arc<AtomicUsize>,
}

impl fmt::Display for FaultyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FaultyStore")
    }
}

#[derive(Debug)]
struct FaultyUpload {
    fail: Fail,
    aborted: Arc<AtomicBool>,
    parts: Arc<AtomicUsize>,
}

fn injected() -> object_store::Error {
    object_store::Error::Generic {
        store: "faulty",
        source: "injected write failure".into(),
    }
}

#[async_trait::async_trait]
impl MultipartUpload for FaultyUpload {
    fn put_part(&mut self, _data: PutPayload) -> UploadPart {
        self.parts.fetch_add(1, Ordering::SeqCst);
        let fail = matches!(self.fail, Fail::Part);
        Box::pin(async move { if fail { Err(injected()) } else { Ok(()) } })
    }
    async fn complete(&mut self) -> object_store::Result<PutResult> {
        Err(injected())
    }
    async fn abort(&mut self) -> object_store::Result<()> {
        self.aborted.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait::async_trait]
impl ObjectStore for FaultyStore {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }
    async fn put_multipart_opts(
        &self,
        _location: &Path,
        _opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        Ok(Box::new(FaultyUpload {
            fail: self.fail,
            aborted: self.aborted.clone(),
            parts: self.parts.clone(),
        }))
    }
    async fn get_opts(
        &self,
        location: &Path,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        self.inner.get_opts(location, options).await
    }
    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        self.inner.delete(location).await
    }
    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }
    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }
    async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy(from, to).await
    }
    async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy_if_not_exists(from, to).await
    }
}

#[tokio::test]
async fn storage_write_failures_abort_the_upload_and_never_issue_a_receipt() {
    for fail in [Fail::Part, Fail::Complete] {
        let aborted = Arc::new(AtomicBool::new(false));
        let parts = Arc::new(AtomicUsize::new(0));
        let store = Arc::new(FaultyStore {
            inner: InMemory::new(),
            fail,
            aborted: aborted.clone(),
            parts: parts.clone(),
        });
        let st = state(store.clone(), 1 << 20);
        // Small parts force writes mid-stream, so Fail::Part trips before the body ends.
        let st = Arc::new(app::AppState {
            part_bytes: 8,
            ..Arc::try_unwrap(st).ok().unwrap()
        });
        let (status, body) = send(
            app::router(st),
            Some(grant(1 << 20, now() + 60)),
            "a.png",
            PNG.repeat(4),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{fail:?}: {body}");
        assert!(
            body.get("receipt").is_none(),
            "{fail:?}: no receipt on failure"
        );
        assert!(
            aborted.load(Ordering::SeqCst),
            "{fail:?}: the multipart upload was aborted"
        );
        assert!(parts.load(Ordering::SeqCst) >= 1);
        assert_eq!(
            futures::StreamExt::count(store.inner.list(None)).await,
            0,
            "{fail:?}: nothing stored"
        );
    }
}

#[tokio::test]
async fn previews_render_inline_with_ranges_only_for_inert_types() {
    let dir = tempfile::tempdir().unwrap();
    let (r, _) = on_disk(dir.path(), 1 << 20);
    let (status, body) = send(
        r.clone(),
        Some(grant(1 << 20, now() + 60)),
        "box.png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let receipt: Value =
        token::verify(SECRET, body["receipt"].as_str().unwrap(), "receipt", now()).unwrap();
    let pending = receipt["objectKey"].as_str().unwrap().to_string();
    let preview = |key: &str, kind: &str, ty: &str| {
        format!(
            "/v1/preview?token={}",
            token::sign(
                SECRET,
                &json!({ "v": 1, "kind": kind, "key": key, "type": ty, "exp": now() + 60 })
            )
        )
    };
    assert_eq!(
        get(r.clone(), &preview(&pending, "preview", "image/png"))
            .await
            .status(),
        StatusCode::NOT_FOUND,
        "pending files have no preview"
    );
    let (_, committed) = call(r.clone(), "/v1/commit", &key_token("commit", &pending)).await;
    let key = committed["objectKey"].as_str().unwrap().to_string();

    let res = get(r.clone(), &preview(&key, "preview", "image/png")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(res.headers()[header::CONTENT_DISPOSITION], "inline");
    assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(
        res.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(
        res.into_body().collect().await.unwrap().to_bytes().as_ref(),
        PNG
    );

    let ranged = r
        .clone()
        .oneshot(
            Request::get(preview(&key, "preview", "image/png"))
                .header(header::RANGE, "bytes=1-3")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        ranged.headers()[header::CONTENT_RANGE],
        format!("bytes 1-3/{}", PNG.len())
    );
    assert_eq!(
        ranged
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        &PNG[1..4]
    );

    let past_end = r
        .clone()
        .oneshot(
            Request::get(preview(&key, "preview", "image/png"))
                .header(header::RANGE, "bytes=9999-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(past_end.status(), StatusCode::RANGE_NOT_SATISFIABLE);

    // A preview token cannot download, a download token cannot preview, and scriptable types are never served inline.
    assert_eq!(
        get(r.clone(), &preview(&key, "download", "image/png"))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(r.clone(), &preview(&key, "preview", "text/html"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(r, &preview(&key, "preview", "image/svg+xml"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}
