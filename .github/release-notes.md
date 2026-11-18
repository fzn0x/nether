Nether is the local-first note taking app that you truly own, with a
server that syncs it on a machine you control. Your notes stay plain
Markdown files in a folder you choose, and the app works fully offline
with no account.

This release adds the phone apps. Android installs from this page, and
iPhone builds from the source with a free Apple ID. Both keep a vault
offline, sync it with your server, and save what you share to them.

It also adds plugins, which run sandboxed and install from the directory;
AI from your own provider; share links and published sites; buttons and
database triggers; a REST API, webhooks and a web clipper; and PDF
highlights. A server can now run on several nodes and on Kubernetes, with
single sign-on, SCIM and LDAP, audit logs, data policies and an admin
console, all free and off until an admin turns them on.

It also fixes a bug that could move a page's notes to the trash on every
device when the page stopped being shared on its own. Update every device
and the server.

## Get it

| System | Download |
| --- | --- |
| Windows 10 and 11 (x64) | [nether-{version}-windows-amd64-setup.exe]({url}/nether-{version}-windows-amd64-setup.exe) |
| macOS 12 or later (Apple silicon and Intel) | [nether-{version}-darwin-universal.dmg]({url}/nether-{version}-darwin-universal.dmg) |
| Linux (x64), updating itself | `curl -fsSL https://github.com/fzn0x/nether/releases/latest/download/install.sh \| sh` |
| Debian and Ubuntu (x64) | [nether_{version}_amd64.deb]({url}/nether_{version}_amd64.deb) |
| Linux, any (x64) | [nether-{version}-x86_64.appimage]({url}/nether-{version}-x86_64.appimage), or the [Flatpak bundle]({url}/nether-{version}-x86_64.flatpak) |
| The server (amd64 and arm64) | `ghcr.io/fzn0x/nether-server:{version}`, started with PostgreSQL and Valkey by the [`docker-compose.yml`](https://github.com/fzn0x/nether/blob/v{version}/deploy/docker/docker-compose.yml): see [Run a server](https://fzn0x.github.io/nether/self-hosting/) |
| The server on Kubernetes | `helm install nether oci://ghcr.io/fzn0x/charts/nether --version {version}`: see [Kubernetes](https://fzn0x.github.io/nether/kubernetes/) |
| Android 7 or later | [nether-{version}-android.apk]({url}/nether-{version}-android.apk), installed over the last one; see [On Android](https://fzn0x.github.io/nether/install/#on-android) |
| iPhone and iPad, iOS 16.4 or later | Built from the source on a Mac with Xcode and a free Apple ID: see [On iPhone and iPad](https://fzn0x.github.io/nether/install/#on-iphone-and-ipad) |
| The web clipper | Chrome, Edge and Brave: [nether-clipper-chrome-{version}.zip]({url}/nether-clipper-chrome-{version}.zip); Firefox: [nether-clipper-firefox-{version}.xpi]({url}/nether-clipper-firefox-{version}.xpi), or [the ZIP]({url}/nether-clipper-firefox-{version}.zip) to load for a session. See [Web clipper](https://fzn0x.github.io/nether/clipper/) |

Nether installed from the Windows installer, the macOS disk image or the
Linux install script updates itself, asking first; it can be turned off.
The Debian package, the AppImage and the Flatpak do not: download the
next release when it comes. On Linux, Nether needs GTK 3 and WebKitGTK
4.1 (`sudo apt install libwebkit2gtk-4.1-0` on Debian and Ubuntu); on
Windows 10, the WebView2 Runtime, which Windows 11 has. `SHA256SUMS`
lists every file's checksum.

### A server of your own

In a folder with the release's `docker-compose.yml`, `docker compose up -d`
starts the server on `http://127.0.0.1:3000`. Open it in a browser, or
connect the desktop app to it, and set it up with the code in its log
(`docker compose logs server`). Put it behind HTTPS before others use it;
the guide shows how.

### The first time you open the app

These builds are not code signed yet, so your system asks before opening
them the first time:

- **Windows**: SmartScreen says "Windows protected your PC". Click **More
  info**, then **Run anyway**.
- **macOS**: macOS says Nether cannot be opened. Open **System Settings**,
  **Privacy & Security**, and click **Open Anyway** beside Nether; or run
  `xattr -dr com.apple.quarantine /Applications/Nether.app`.
- **Linux**: make the AppImage executable, `chmod +x nether-{version}-x86_64.appimage`.
