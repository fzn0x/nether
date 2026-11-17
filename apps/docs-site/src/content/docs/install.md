---
title: Install Nether
description: Where to download the Nether desktop app for Windows, macOS and Linux, how to open it the first time, and how it updates.
---

Nether's desktop app keeps your notes on your computer and works fully
offline, with no account. A Nether server, which you
[run with Docker Compose](../self-hosting/), adds sync between your
devices, sharing and collaboration, and serves the web app.

## Download

Every release is on
[GitHub](https://github.com/fzn0x/nether/releases/latest).

| System | Download |
| --- | --- |
| Windows 10 and 11 (x64) | [The Windows installer](https://github.com/fzn0x/nether/releases/download/v0.1.0/nether-0.1.0-windows-amd64-setup.exe) |
| macOS 12 or later (Apple silicon and Intel) | [The disk image](https://github.com/fzn0x/nether/releases/download/v0.1.0/nether-0.1.0-darwin-universal.dmg) |
| Linux (x64), updating itself | The install script, below |
| Debian and Ubuntu (x64) | [The Debian package](https://github.com/fzn0x/nether/releases/download/v0.1.0/nether_0.1.0_amd64.deb) |
| Linux, any (x64) | [The AppImage](https://github.com/fzn0x/nether/releases/download/v0.1.0/nether-0.1.0-x86_64.appimage), or the [Flatpak bundle](https://github.com/fzn0x/nether/releases/download/v0.1.0/nether-0.1.0-x86_64.flatpak) |

On Linux, the install script puts Nether in your home folder, with no
root, and adds it to the applications menu and the `nether` command:

```sh
curl -fsSL https://github.com/fzn0x/nether/releases/latest/download/install.sh | sh
```

`sh install.sh --uninstall` removes it again and leaves your settings.

Nether needs, on Linux, GTK 3 and WebKitGTK 4.1
(`sudo apt install libwebkit2gtk-4.1-0` on Debian and Ubuntu), and on
Windows 10, the WebView2 Runtime, which Windows 11 has. The release's
`SHA256SUMS` lists every file's checksum.

## The first time you open it

The builds are not code signed yet, so your system asks before opening
them the first time:

- **Windows**: SmartScreen says "Windows protected your PC". Click **More
  info**, then **Run anyway**.
- **macOS**: macOS says Nether cannot be opened. Open **System Settings**,
  **Privacy & Security**, and click **Open Anyway** beside Nether; or run
  `xattr -dr com.apple.quarantine /Applications/Nether.app`.
- **Linux**: make the AppImage executable,
  `chmod +x nether-0.1.0-x86_64.appimage`.

Then choose **Open a folder** and pick a folder of notes, or an empty one;
[Vaults](../vaults/) tells the rest.

## Updates

Nether installed from the Windows installer, the macOS disk image or the
Linux install script checks for a new version and asks before it updates.
**Settings**, **Check for updates…** checks now, and **Turn automatic
update checks off** stops the checks.

The Debian package, the AppImage and the Flatpak do not update
themselves: download the next release when it comes.

## On Android

Each [release](https://github.com/fzn0x/nether/releases/latest) has the
Android app, `nether-<version>-android.apk`, for Android 7 and later: free,
with no store and no account. Open it on the phone, and allow your browser
or files app to install apps when Android asks, once. The next release's
APK installs over it and keeps your vaults, as every release is signed with
the same key; its certificate's SHA-256 is
`4D:41:BA:99:71:85:85:75:FF:88:BE:AC:1B:87:D2:C6:95:8C:DA:0F:22:F5:B7:47:45:9F:90:32:78:55:4B:EB`,
which `apksigner verify --print-certs` shows. Then give a vault a name:
it is a folder of Markdown notes in the app's own storage, which works
with no account. Opening the same name again finds its notes, and the
app opens to the vault it had open last. Each note is saved as you leave
the app, so nothing typed is lost when the phone ends it.

To sync, choose **Sign in to a server** on the first screen, then tap one
of your workspaces: it opens as a vault on the phone, which syncs while
Nether is open ([On a phone](../servers/#on-a-phone)).

Touch and hold Nether's icon for its shortcuts: **Capture** opens a sheet
for a quick note at once, before the vault does, and **New note**,
**Today's note** and **Search** open your last vault at those. Text,
links, images, PDFs, audio and video shared to Nether from another app
open the same sheet, and **Save** files each as a new note in the vault's
Inbox ([Quick capture](../writing/#quick-capture-on-a-phone)). Exports, and
**Send a copy** of a note, go to the share sheet
([On a phone](../export/#on-a-phone)).

## On iPhone and iPad

The iOS app is free, and built from the source on a Mac with Xcode 26, for
iOS 16.4 and later; it is in no store. A free Apple ID is enough to sign it
for your own phone:

1. In Xcode's settings, under **Accounts**, add your Apple ID. Xcode makes
   it a personal team.
2. Give the app IDs of your own: in `apps/mobile/ios`, make a file
   `nether.local.xcconfig`, which git ignores, with one line,
   `NETHER_BUNDLE_ID = com.yourname.nether`, a name no one else uses. The
   share extension's ID and the App Group the two share follow from it
   ([`nether.xcconfig`](https://github.com/fzn0x/nether/blob/main/apps/mobile/ios/nether.xcconfig)).
3. Run `pnpm install` and `pnpm --filter @nether/mobile build`, open
   `apps/mobile/ios/App/App.xcodeproj`, choose your personal team under
   **Signing & Capabilities** for both the `App` and `ShareExtension`
   targets, and run it on your phone.

An app signed by a free Apple ID runs for 7 days: run it from Xcode again
to renew it, and your vaults stay. Apple sets the limits of free teams,
and the project has not tried every one on a device; if yours refuses the
App Group, tell us in an
[issue](https://github.com/fzn0x/nether/issues/new?template=bug_report.yml).

Give a vault a name: it is a folder of Markdown notes in the app's
Documents, which the Files app shows under On My iPhone, Nether, and which
works with no account. Notes another app changes there show when you come
back to Nether. Each note is saved as you leave the app. Signing in to a
server and opening its workspaces works as on Android, and so do the
icon's quick actions, exports and **Send a copy**.

Nether shows in other apps' share sheets: its own sheet asks which vault a
text, a link, images or files go to, and Nether files them as notes in the
vault's Inbox as it opens. The share sheet and the app share the App Group
`group.` and your bundle ID, `group.io.github.fzn0x.nether` for the
project's.

## From the source

You need Node.js 24, pnpm 10 and Go 1.27:

```sh
git clone https://github.com/fzn0x/nether.git
cd nether
pnpm install
pnpm --filter @nether/desktop dev
```

The repository's
[CONTRIBUTING.md](https://github.com/fzn0x/nether/blob/main/CONTRIBUTING.md)
has the rest.
