PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
LIBRARY ?= $(CURDIR)
HOST ?= 0.0.0.0
PORT ?= 8080
SERVICE ?= gomoov
# SHOW_PRIVATE=1 adds --show-private to the systemd unit (simple player only).
SHOW_PRIVATE ?=
EXTRA :=
ifneq ($(SHOW_PRIVATE),)
EXTRA := --show-private
endif
# Static GPL build (includes libx264). linux x86_64. Override for another arch.
FFMPEG_URL ?= https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz

.PHONY: all install install-service install-user-service fetch-ffmpeg with-ffmpeg install-with-ffmpeg

all: gomoov

gomoov: $(wildcard *.go) index.html app.js styles.css go.mod
	go build -o gomoov .

# Download static ffmpeg and ffprobe, then pack them into the gomoov binary.
fetch-ffmpeg:
	mkdir -p build/ffmpeg-src build/ffmpeg
	curl -fL --retry 3 -o build/ffmpeg.tar.xz "$(FFMPEG_URL)"
	tar -xJf build/ffmpeg.tar.xz -C build/ffmpeg-src --strip-components=1
	cp build/ffmpeg-src/bin/ffmpeg build/ffmpeg-src/bin/ffprobe build/ffmpeg/
	chmod 755 build/ffmpeg/ffmpeg build/ffmpeg/ffprobe
	build/ffmpeg/ffmpeg -version | head -n 1

with-ffmpeg: fetch-ffmpeg
	go build -tags embedffmpeg -o gomoov .

install-with-ffmpeg: with-ffmpeg
	install -d "$(BINDIR)"
	install -m 755 gomoov "$(BINDIR)/gomoov"

install: gomoov
	install -d "$(BINDIR)"
	install -m 755 gomoov "$(BINDIR)/gomoov"

# LIBRARY is the movie folder (default: the directory you run make from).
# HOST, PORT, and SHOW_PRIVATE=1 are written into the unit.
# Both targets install the binary and start gomoov -U.
install-user-service: install
	@set -e; \
	unitdir="$(HOME)/.config/systemd/user"; \
	install -d "$$unitdir"; \
	sed \
		-e 's|@BINDIR@|$(BINDIR)|g' \
		-e 's|@LIBRARY@|$(LIBRARY)|g' \
		-e 's|@HOST@|$(HOST)|g' \
		-e 's|@PORT@|$(PORT)|g' \
		-e 's|@EXTRA@|$(EXTRA)|g' \
		-e 's|@WANTED@|default.target|g' \
		-e 's|@USER_LINE@||g' \
		-e 's|@HOME_LINE@||g' \
		gomoov.service.in > "$$unitdir/$(SERVICE).service"; \
	systemctl --user daemon-reload; \
	systemctl --user enable --now "$(SERVICE).service"; \
	echo "installed $$unitdir/$(SERVICE).service (library $(LIBRARY))"

install-service: install
	@set -e; \
	if [ "$$(id -u)" -ne 0 ]; then \
		echo "make install-service must be run as root. For your own session, run make install-user-service." >&2; \
		exit 1; \
	fi; \
	run_user="$${SUDO_USER:-root}"; \
	run_home="$$(getent passwd "$$run_user" | cut -d: -f6)"; \
	unitdir=/etc/systemd/system; \
	install -d "$$unitdir"; \
	sed \
		-e 's|@BINDIR@|$(BINDIR)|g' \
		-e 's|@LIBRARY@|$(LIBRARY)|g' \
		-e 's|@HOST@|$(HOST)|g' \
		-e 's|@PORT@|$(PORT)|g' \
		-e 's|@EXTRA@|$(EXTRA)|g' \
		-e 's|@WANTED@|multi-user.target|g' \
		-e "s|@USER_LINE@|User=$$run_user|g" \
		-e "s|@HOME_LINE@|Environment=HOME=$$run_home|g" \
		gomoov.service.in > "$$unitdir/$(SERVICE).service"; \
	systemctl daemon-reload; \
	systemctl enable --now "$(SERVICE).service"; \
	echo "installed $$unitdir/$(SERVICE).service (library $(LIBRARY), user $$run_user)"
