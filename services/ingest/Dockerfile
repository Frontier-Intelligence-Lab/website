# Build: docker build -t valcairn-ingest services/ingest
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/valcairn-ingest /usr/local/bin/valcairn-ingest
ENV INGEST_BIND=0.0.0.0:4100
EXPOSE 4100
USER nonroot
ENTRYPOINT ["/usr/local/bin/valcairn-ingest"]
