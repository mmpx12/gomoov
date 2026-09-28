# gomoov with ffmpeg

This build includes ffmpeg and ffprobe. You do not install them yourself. The first time gomoov runs, it unpacks them into `~/.gomoov/bin` (on Windows, `%USERPROFILE%\.gomoov\bin`).

## Install

Linux or macOS, from this folder:

```bash
./install.sh
```

That copies `gomoov` to `~/.local/bin`. Set `PREFIX` to use another location:

```bash
PREFIX=/usr/local ./install.sh
```

Windows, from this folder, in PowerShell:

```powershell
.\install.ps1
```

That copies `gomoov.exe` to `%LOCALAPPDATA%\gomoov` and adds that folder to your user PATH.

## Run

Open a terminal in the folder that contains your movies, then:

```bash
gomoov
```

Add `-U` for accounts, uploads, and private videos. The default address is `http://0.0.0.0:8080`. The first run prints a one-time admin password in the log. Sign in with it and choose a new password. `gomoov -R admin` prints a new one-time password and exits.
