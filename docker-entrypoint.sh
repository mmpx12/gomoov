#!/bin/sh
set -eu

home="${HOME:-/var/lib/gomoov}"
mkdir -p "$home"

if [ "$#" -eq 0 ]; then
	set -- -L "${LIBRARY:-/videos}" -H "${HOST:-0.0.0.0}" -p "${PORT:-8080}"
	if [ "${USER_MODE:-1}" != "0" ]; then
		set -- -U "$@"
	fi
	if [ "${SHOW_PRIVATE:-0}" = "1" ]; then
		set -- --show-private "$@"
	fi
fi

if [ "$(id -u)" = 0 ]; then
	chown gomoov:gomoov "$home"
	exec runuser -u gomoov -- gomoov "$@"
fi
exec gomoov "$@"
