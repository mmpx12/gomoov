#!/bin/sh
set -eu
cd "$(dirname "$0")"
prefix="${PREFIX:-$HOME/.local}"
bindir="$prefix/bin"
mkdir -p "$bindir"
if [ ! -f gomoov ]; then
	echo "gomoov is not in this folder." >&2
	exit 1
fi
if command -v install >/dev/null 2>&1; then
	install -m 755 gomoov "$bindir/gomoov"
else
	cp gomoov "$bindir/gomoov"
	chmod 755 "$bindir/gomoov"
fi
echo "Installed $bindir/gomoov"
echo "ffmpeg and ffprobe are inside this build. The first run unpacks them to ~/.gomoov/bin."
case ":$PATH:" in
	*":$bindir:"*) ;;
	*) echo "Add $bindir to PATH, then open a new terminal." ;;
esac
echo "From your movie folder: gomoov"
echo "With accounts: gomoov -U"
