# syntax=docker/dockerfile:1.7

FROM rust:1.94-bookworm AS rust-builder

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --locked --release --package executor-worker

FROM ubuntu:24.04 AS nsjail-builder

ARG DEBIAN_FRONTEND=noninteractive
ARG NSJAIL_VERSION=3.6
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        autoconf \
        bison \
        build-essential \
        ca-certificates \
        flex \
        git \
        libnl-route-3-dev \
        libprotobuf-dev \
        libseccomp-dev \
        libtool \
        make \
        pkg-config \
        protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
RUN git clone \
        --branch "${NSJAIL_VERSION}" \
        --depth 1 \
        --recurse-submodules \
        https://github.com/google/nsjail.git \
        /src/nsjail \
    && make --directory /src/nsjail --jobs "$(nproc)"

FROM ubuntu:24.04 AS production

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        clang \
        libcap2 \
        libnl-route-3-200 \
        libprotobuf32t64 \
        libseccomp2 \
        musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /nonexistent worker \
    && mkdir --parents /jail/workspace /jail/tmp /work \
    && chmod 1777 /work

COPY crates/executor-worker/runtime-support/stdio.c /tmp/smart-c-runtime-support/stdio.c
RUN mkdir --parents /usr/local/lib/smart-c \
    && musl-gcc \
        -std=c17 \
        -O2 \
        -Wall \
        -Wextra \
        -Wpedantic \
        -c /tmp/smart-c-runtime-support/stdio.c \
        -o /usr/local/lib/smart-c/runtime-support.o \
    && chmod 0444 /usr/local/lib/smart-c/runtime-support.o \
    && rm --recursive /tmp/smart-c-runtime-support

COPY --from=rust-builder /src/target/release/executor-worker /usr/local/bin/executor-worker
COPY --from=nsjail-builder /src/nsjail/nsjail /usr/local/bin/nsjail
COPY infra/nsjail /etc/smart-c/nsjail
COPY LICENSE LICENSES/Apache-2.0.txt THIRD_PARTY_NOTICES.md /usr/share/licenses/smart-c-playground/

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/executor-worker"]
