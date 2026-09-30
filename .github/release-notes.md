The header menu icon opens Theme and About. Theme opens the theme list as a submenu. The row under the pointer uses that theme's own colors, and the list scrolls when the window is short. Without accounts, the choice stays in the browser. With accounts, that menu sits next to Sign in until you sign in. Settings and Admin keep the full list. Rose and Steel join Amber and Lavender. About shows this version and a link to the repository. In Cyber green, section titles such as Continue watching and Library are phosphor green, while movie names keep their color.

Posters skip a black or solid-color opening frame, so a title that starts dark still gets a thumbnail. `go install github.com/mmpx12/gomoov@latest` installs this version. The module path matches the repository.

The header uses the brutalist gomoov mark again. A series is one card, the next episode starts after a countdown, and Continue watching, Watch later, and Recently added follow the signed-in account. A `.srt` or `.vtt` next to a movie is a subtitle, the library can filter watched titles, and the timeline shows a preview while you drag it.

The first admin password is generated and printed once in the log. `gomoov -R USER` sets a new one-time password for that account and exits.

## Which file to download

Pick the archive that matches your machine. A name ending in `-ffmpeg` already contains ffmpeg and ffprobe, plus `README.md` and an install script. The other files use `ffmpeg` and `ffprobe` that are already on your PATH.

| Machine | ffmpeg already installed | no ffmpeg to install |
| --- | --- | --- |
| Linux x86_64 | `gomoov-linux-amd64.tar.gz` | `gomoov-linux-amd64-ffmpeg.tar.gz` |
| Linux arm64 | `gomoov-linux-arm64.tar.gz` | `gomoov-linux-arm64-ffmpeg.tar.gz` |
| Windows x86_64 | `gomoov-windows-amd64.exe.zip` | `gomoov-windows-amd64-ffmpeg.exe.zip` |
| Windows arm64 | `gomoov-windows-arm64.exe.zip` | `gomoov-windows-arm64-ffmpeg.exe.zip` |
| macOS Intel | `gomoov-darwin-amd64.tar.gz` | install ffmpeg yourself, then use the same file |
| macOS Apple silicon | `gomoov-darwin-arm64.tar.gz` | install ffmpeg yourself, then use the same file |

Linux and macOS archives are `.tar.gz`. Windows archives are `.zip`.

For a `-ffmpeg` archive, unpack it and run the script in that folder:

```bash
tar -xzf gomoov-linux-amd64-ffmpeg.tar.gz
cd gomoov
./install.sh
```

```powershell
Expand-Archive gomoov-windows-amd64-ffmpeg.exe.zip
cd gomoov
.\install.ps1
```

Then open a terminal in the movie folder and run `gomoov`. Add `-U` for accounts. The first run prints a one-time admin password in the log. Sign in with it and choose a new password. `gomoov -R admin` prints a new one-time password and exits.
