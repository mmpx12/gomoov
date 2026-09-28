PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

.PHONY: all install

all: gomoov

gomoov: main.go index.html app.js styles.css go.mod
	go build -o gomoov .

install: gomoov
	install -d "$(BINDIR)"
	install -m 755 gomoov "$(BINDIR)/gomoov"
