use std::{sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{HeaderValue, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use object_store::{local::LocalFileSystem, path::Path};
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

fn router(dir: &std::path::Path, max_bytes: u64) -> axum::Router {
    app::router(Arc::new(app::AppState {
        store: Arc::new(LocalFileSystem::new_with_prefix(dir).unwrap()),
        prefix: Path::default(),
        secret: SECRET.to_vec(),
        max_bytes,
        idle: Duration::from_secs(5),
        allowed_origins: vec![HeaderValue::from_static("http://localhost:3000")],
    }))
}

fn grant(max_bytes: u64, exp: u64) -> String {
    token::sign(
        SECRET,
        &json!({ "v": 1, "kind": "upload", "ws": WS, "project": PROJECT, "by": USER, "maxBytes": max_bytes, "exp": exp, "nonce": "n" }),
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

#[tokio::test]
async fn stores_a_valid_upload_and_returns_a_verifiable_receipt_then_serves_it_as_a_download() {
    let dir = tempfile::tempdir().unwrap();
    let r = router(dir.path(), 1 << 20);
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
    assert_eq!(body["sizeBytes"], PNG.len());

    let receipt: Value = token::verify(SECRET, body["receipt"].as_str().unwrap(), "receipt", now())
        .expect("receipt verifies");
    assert_eq!(receipt["ws"], WS);
    assert_eq!(receipt["by"], USER);
    let key = receipt["objectKey"].as_str().unwrap().to_string();
    assert!(key.starts_with(&format!("ws/{WS}/projects/{PROJECT}/uploads/")));
    assert_eq!(receipt["sha256"].as_str().unwrap().len(), 64);

    let download = token::sign(
        SECRET,
        &json!({ "v": 1, "kind": "download", "key": key, "filename": "box 1.png", "exp": now() + 60 }),
    );
    let res = r
        .clone()
        .oneshot(
            Request::get(format!("/v1/objects?token={download}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
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

    // An upload receipt or a forged key is not a download token.
    let res = r
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/objects?token={}",
                body["receipt"].as_str().unwrap()
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refuses_missing_expired_or_forged_grants() {
    let dir = tempfile::tempdir().unwrap();
    let r = router(dir.path(), 1 << 20);
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
        &json!({ "kind": "upload", "ws": WS, "project": PROJECT, "by": USER, "maxBytes": 10, "exp": now() + 60 }),
    );
    assert_eq!(
        send(r.clone(), Some(forged), "a.png", PNG.to_vec()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let bad_ids = token::sign(
        SECRET,
        &json!({ "kind": "upload", "ws": "../../etc", "project": PROJECT, "by": USER, "maxBytes": 10, "exp": now() + 60 }),
    );
    assert_eq!(
        send(r, Some(bad_ids), "a.png", PNG.to_vec()).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn enforces_size_limits_type_rules_and_leaves_no_rejected_files_behind() {
    let dir = tempfile::tempdir().unwrap();
    let r = router(dir.path(), 64);
    let mut big = PNG.to_vec();
    big.resize(65, 0);
    // The server cap (64) wins over a larger grant.
    assert_eq!(
        send(r.clone(), Some(grant(1 << 20, now() + 60)), "big.png", big)
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        send(
            r.clone(),
            Some(grant(1 << 20, now() + 60)),
            "setup.png",
            b"MZ\x90\x00\x03\x00\x00\x00".to_vec()
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        send(
            r.clone(),
            Some(grant(1 << 20, now() + 60)),
            "page.csv",
            b"<html><script>".to_vec()
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        send(
            r.clone(),
            Some(grant(1 << 20, now() + 60)),
            "empty.csv",
            Vec::new()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, body) = send(
        r,
        Some(grant(1 << 20, now() + 60)),
        "../../labels.csv",
        b"id,label\n1,ok\n".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["filename"], "labels.csv");
    assert_eq!(body["contentType"], "text/csv");

    let stored: Vec<_> = walk(dir.path());
    assert_eq!(
        stored.len(),
        1,
        "only the accepted file remains: {stored:?}"
    );
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
