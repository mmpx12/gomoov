# gomoov

gomoov is a local web player for the video files in a folder. A normal launch is that player. Accounts, uploads, and private videos are there when you start it with `--user-mode`.

The page, script, and stylesheet are built into the `gomoov` binary. Playback uses `ffmpeg` and `ffprobe`, which stay installed on the machine.

## Requirements

- Go 1.22 or newer, to build
- `ffmpeg` and `ffprobe` on `PATH`
- A browser on the machine that will watch

## Build and install

```bash
make
make install
```

`make install` copies the binary to `~/.local/bin/gomoov`. `PREFIX` and `BINDIR` change that location:

```bash
make install PREFIX=/usr/local
```

## Run

Start it in the folder that holds the movies. It listens on `0.0.0.0:8080` unless `HOST` or `PORT` is set.

```bash
cd ~/moovies
gomoov
```

That is the simple player. The library in this folder is listed, and so are public uploads under `~/gomoov`. Sign-in, the user list, and private uploads are hidden. Anyone who can open the address can play the public videos.

```bash
gomoov -U
gomoov --user-mode
```

User mode is the account server. The first run creates `admin` / `admin`. Change that password from the account menu. An admin can add users, set a password, force a change at the next sign-in, allow or refuse uploads, open someone’s videos, and ban or delete an account. Ban and delete ask for confirmation. A banned person is signed out and cannot sign in. Deleting an account also deletes the videos in that person’s `~/gomoov/<id>/` folder. The admin account cannot be banned or deleted.

Private uploads are visible to their owner and to the admin. Other people, and anyone who is not signed in, see public videos only. In the simple player, private uploads stay hidden even for the owner. Add `--show-private` to include them for that launch:

```bash
gomoov --show-private
```

`--show-private` does nothing in user mode. `-p` is the listen port, not this switch.

## Flags

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Show help and exit |
| `-H`, `--host ADDR` | Listen address. Overrides `HOST`. Default `0.0.0.0` |
| `-p`, `--port PORT` | Listen port. Overrides `PORT`. Default `8080` |
| `-V`, `--version` | Print the version and exit |
| `-U`, `--user-mode` | Accounts, uploads, and the usual private-video rules |
| `--show-private` | In the simple player, also show private uploads |
| `-m`, `--movie PATH` | Open this video in a browser |
| `-i`, `--include DIR` | Only scan these directories |
| `-e`, `--exclude DIR` | Skip these directories |

`-i` and `-e` can be repeated, or take a comma-separated list. Paths may be absolute, relative to the launch folder, or start with `~/`. An include may be outside the launch folder. An include inside an exclude is an error.

```bash
gomoov -i ~/movies,/other/films
gomoov --exclude ~/movies/extras,~/movies/samples
gomoov -e ~/movies/extras -e ~/movies/samples
gomoov -m ~/movies/episode.mkv
```

`~/gomoov` stays available either way: public uploads are listed, and private ones follow the rules above.

## While you watch

The home page can sort by name, newest, longest, size, or path, and can group a path sort into collapsible folders. Refresh checks the folder for new files. Continue watching is shared across every folder where gomoov is launched, and a movie is listed only when that file is in the current library. Resume is stored by absolute path in `~/.gomoov/progress.json`.

The header and the browser tab say **gomoov**.

In user mode, **My videos** limits the home page to uploads from the signed-in account. **Settings** has three tabs:

- **Password** changes the account password.
- **My videos** lists that account’s uploads and can remove one.
- **Theme** picks a personal theme, or **Site default**.

Themes are Dark (the default), White, Cyber green, Fancy, Neon, Cyberpunk, Retro, Ocean, and Sunset. Cyber green follows gonitor: a very dark background, yellow headings, green links, and a dark-green bar on the active menu item. A personal theme is stored on the account and wins over the site theme. **Site default** follows the theme saved in Admin.

## Admin

Sign in as an admin and open **Admin**.

- **Users** adds accounts and opens one to set a password, allow uploads, ban, or delete. Ban and delete ask for confirmation.
- **Videos** lists every title, with the owner’s username. A file from the launch folder is marked Library.
- **Access** turns on HTTP basic auth and an IP allow list or exclude list.
- **Theme** sets the site default.

Basic auth asks the browser for a username and password before any page or video. It is separate from account sign-in. Leave the password blank when you save other access settings and the current basic-auth password stays.

The IP rule is off, allow only the listed addresses, or exclude the listed addresses. A line can be one IP or a CIDR range such as `192.168.1.0/24`. `127.0.0.1` is always allowed. A save that would block the request you are making is refused.

The site theme chosen here is the default for people who have not picked their own.

## Where files go

| Path | What it is |
| --- | --- |
| Launch folder | Movies gomoov scans, minus anything excluded |
| `~/gomoov/<user-id>/` | Videos that account uploaded |
| `~/.gomoov/users.json` | Accounts and password hashes |
| `~/.gomoov/sessions.json` | Sign-in sessions |
| `~/.gomoov/visibility.json` | Which uploads are private |
| `~/.gomoov/progress.json` | Continue watching |
| `/tmp/moovies-cache` | Probe, thumbnail, and subtitle cache. Override with `MOOVIES_CACHE` |

## systemd

Both targets install the binary and a service that runs `gomoov -U` in the movie folder. `LIBRARY` is that folder and defaults to the directory you run `make` from.

Your own user service:

```bash
cd ~/moovies
make install-user-service
```

The unit is `~/.config/systemd/user/gomoov.service`. It starts now and again at login. To keep it running when you are logged out:

```bash
loginctl enable-linger "$USER"
systemctl --user status gomoov
```

A system service, installed as root:

```bash
cd /home/you/moovies
sudo make install-service
```

The unit is `/etc/systemd/system/gomoov.service`. `make install-service` refuses to run unless you are root. If you used `sudo`, the process runs as `SUDO_USER` so `~/gomoov` and `~/.gomoov` belong to that person. A root shell with no `SUDO_USER` runs the service as root.

```bash
sudo systemctl status gomoov
```

Stop a gomoov you started by hand before enabling either service. Both want port 8080. `SERVICE=gomoov` changes the unit name.

## Development

```bash
go test ./...
```

The version in `main.go` increases on each change. Movies, torrents, and the built `gomoov` binary are not part of the git history.
