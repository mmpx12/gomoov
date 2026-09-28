# Build gomoov, then run it with ffmpeg from Debian.
FROM golang:1.22-bookworm AS build

WORKDIR /src
COPY go.mod ./
COPY *.go index.html app.js styles.css ./
COPY brand ./brand
RUN CGO_ENABLED=0 go build -o /out/gomoov .

FROM debian:bookworm-slim

ARG UID=1000
ARG GID=1000

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --gid "${GID}" gomoov \
	&& useradd --uid "${UID}" --gid "${GID}" --home-dir /var/lib/gomoov --create-home gomoov \
	&& mkdir -p /videos \
	&& chown gomoov:gomoov /var/lib/gomoov

COPY --from=build /out/gomoov /usr/local/bin/gomoov
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV HOME=/var/lib/gomoov
EXPOSE 8080
VOLUME ["/videos", "/var/lib/gomoov"]
ENTRYPOINT ["docker-entrypoint.sh"]
