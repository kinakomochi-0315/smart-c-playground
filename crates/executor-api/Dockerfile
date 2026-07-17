# syntax=docker/dockerfile:1.7

FROM rust:1.94-bookworm AS builder

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --locked --release --package executor-api

FROM debian:bookworm-slim AS production

RUN useradd --system --uid 10001 --create-home --home-dir /nonexistent executor
COPY --from=builder /src/target/release/executor-api /usr/local/bin/executor-api

USER 10001:10001
EXPOSE 4000 50051
ENTRYPOINT ["/usr/local/bin/executor-api"]

