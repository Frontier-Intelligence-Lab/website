use std::sync::Arc;

use tracing_subscriber::EnvFilter;
use valcairn_ingest::{app, config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let config = match config::from_env() {
        Ok(c) => c,
        Err(message) => {
            eprintln!("ingest: {message}");
            std::process::exit(2);
        }
    };
    let listener = tokio::net::TcpListener::bind(&config.bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("ingest: cannot listen on {}: {e}", config.bind);
            std::process::exit(2);
        });
    tracing::info!(bind = %config.bind, "ingest listening");
    axum::serve(listener, app::router(Arc::new(config.state)))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server error");
}

async fn shutdown() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.ok() };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("ingest shutting down");
}
