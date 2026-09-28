PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
LIBRARY ?= $(CURDIR)
SERVICE ?= gomoov

.PHONY: all install install-service install-user-service

all: gomoov

gomoov: main.go auth.go index.html app.js styles.css go.mod
	go build -o gomoov .

install: gomoov
	install -d "$(BINDIR)"
	install -m 755 gomoov "$(BINDIR)/gomoov"

# LIBRARY is the movie folder (default: the directory you run make from).
# Both targets install the binary and start gomoov -U.
install-user-service: install
	@set -e; \
	unitdir="$(HOME)/.config/systemd/user"; \
	install -d "$$unitdir"; \
	sed \
		-e 's|@BINDIR@|$(BINDIR)|g' \
		-e 's|@LIBRARY@|$(LIBRARY)|g' \
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
		-e 's|@WANTED@|multi-user.target|g' \
		-e "s|@USER_LINE@|User=$$run_user|g" \
		-e "s|@HOME_LINE@|Environment=HOME=$$run_home|g" \
		gomoov.service.in > "$$unitdir/$(SERVICE).service"; \
	systemctl daemon-reload; \
	systemctl enable --now "$(SERVICE).service"; \
	echo "installed $$unitdir/$(SERVICE).service (library $(LIBRARY), user $$run_user)"
