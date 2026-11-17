# 0087. The mobile apps run the shared page in Capacitor, with each vault's files and index on the phone

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#apps-and-deployment) ask, in
Phase 5, for mobile apps: "iOS and Android with offline editing, quick
capture and share sheet". The [architecture](../architecture.md) names
Capacitor, reusing the web UI, and draws the mobile app as "SQLite +
offline edits, syncs when online". The
[non-functional requirements](../requirements.md#non-functional-requirements)
for speed, accessibility and languages hold on phones too.

What the apps start from:

- **One page, three backends.** The desktop app and the web app run the
  same React page, `apps/desktop/src`. It reaches its platform only
  through `Backend` in `backend.ts`: the desktop's Go services and MyGO's
  SQLite plugin, as [ADR 0004](0004-desktop-on-mygo.md) has it; the web
  app's backend, each workspace in the origin's private file system and
  its index in SQLite's WebAssembly build, as
  [ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)
  has it; or the preview's vault in memory, which the end-to-end tests
  drive. `packages/storage` already names the mobile apps' file system
  and Capacitor's SQLite as the next to implement `VaultFiles` and
  `Database`.
- **The web app keeps no IndexedDB cache.** ADR 0053 chose the private
  file system over IndexedDB. On a phone both are the WebView's storage.
- **A WebView's storage is not the app's to keep.** Capacitor's
  [storage guide](https://capacitorjs.com/docs/guides/storage) says "the
  OS will reclaim local storage from Web Views if a device is running low
  on space", says the same of IndexedDB on iOS, and points to SQLite for
  data that must last.
- **Phones end apps.** iOS suspends an app soon after it leaves the
  screen, and runs none of its page's scripts while it is suspended.
  Android ends cached processes when it needs their memory. Either may
  end the app without a word. Every edit must be on disk before that, and
  a note's file must never be half written: a truncated file read back
  would merge into the note's document as another app's edit, and delete
  text.
- **The page's origin is the app's.** Capacitor serves it from
  `https://localhost` on Android and `capacitor://localhost` on iOS. The
  server answers no CORS, as
  [ADR 0036](0036-the-desktop-app-reaches-servers-through-go-and-keeps-tokens-in-the-keychain.md)
  chose for the desktop app, so the page's own `fetch` to a server fails
  there too.
- **A phone has no loopback handoff.**
  [ADR 0034](0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md)
  and
  [ADR 0080](0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md)
  bring a provider's sign-in back to the app's loopback address, or to the
  server's own origin for the web app. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)
  gives mobile apps two other ways: a private-use URI scheme, and https
  links the app claims. Claimed links are fixed in the app's build, by the
  domains it names, and a self-hosted server's domain is not among them.
- **The share sheet needs native code on iOS.** Items shared to an iOS
  app arrive in a share extension, a small separate program with a target
  of its own. Android hands them to the app's activity, by the intent
  filters in its manifest.
- **Capacitor 8** needs Node 22, Xcode 26, iOS 15 and Android 7, API level
  24, and compiles for API level 36, as its
  [upgrade guide](https://capacitorjs.com/docs/updating/8-0) says. New iOS
  projects use Swift Package Manager. The page's build targets what Vite
  8.3 targets by default: Chrome 111, Safari 16.4 and iOS 16.4.
- **This machine** has the Android SDK, JDK 17 and an Android 15 emulator
  image, and no macOS: iOS builds run on CI's macOS runners. Signing and
  the stores need the maintainer's own Apple and Google accounts, as the
  web clipper's stores do in [#160](https://github.com/fzn0x/nether/issues/160).

## Decision

### The app

**`apps/mobile` is a Capacitor 8 project**, `@nether/mobile`, with the
desktop app's identifier, `io.github.fzn0x.nether`. It holds the Android
project in Java and the iOS project in Swift, both committed, as
Capacitor expects. Java, as Capacitor's template and the SQLite plugin
have it, needs no Kotlin toolchain in the build.

- **It runs on iOS 16.4 and Android 7 or later.** iOS 16.4 is the oldest
  the page's build runs on. On Android the page runs in the system's
  WebView, which updates apart from the system: the app checks its
  Chromium version at start, 111 or later, and asks for an update of
  Android System WebView below that.
- **The page is the desktop page, built for phones.** `apps/mobile`
  builds `apps/desktop/src` with Vite and `VITE_NETHER_TARGET=mobile`
  into `apps/mobile/dist`, as `apps/web` builds it with `web`, and
  `npx cap sync` copies it into both projects.
  - The app serves it from its own files. Nothing loads from a network,
    and there is no service worker.
  - The build leaves out the web backend and SQLite's WebAssembly.
  - The page's content security policy is the web app's, with sockets
    allowed to any `wss:` address, since servers are the user's to name.
- **Swift and Java keep to what only the phone can do**, as Go does on
  the desktop. A Capacitor plugin of Nether's own, in `apps/mobile` and
  under the repository's license, holds:
  - `NetherVaults`: each vault's files, and the list of vaults and servers;
  - `Inbox`: what the share sheet hands the app;
  - `SignIn`: on iOS, the system's sign-in sheet for providers.

  Everything else comes from maintained Capacitor plugins, listed at the
  end with their licenses. On Android the plugin is in the app's project;
  on iOS it is a Swift package of its own, `apps/mobile/plugin`, linked as
  `@nether/mobile-plugin`, so Capacitor's CLI adds it to the app as it does
  each plugin from npm, and its tests run without the app.

### A vault on the phone

**A vault is a folder of Markdown files on the phone, with its index in
SQLite**, as on the desktop.

- **Where.** On iOS each vault is a folder in the app's Documents, named
  as the vault is. The app declares that it opens documents in place, so
  the Files app shows the vaults under On My iPhone, Nether, and other
  apps can open their notes. On Android each vault is a folder in the
  app's own files, which only the app reads. The list of vaults, each with
  its ID, name and folder, is a file in the app's support folder, outside
  every vault.
- **Files through `NetherVaults`.** The plugin does what the desktop's Go
  service does, behind `VaultFiles`:
  - A write goes to a temporary file in the same folder, is synced to the
    disk, and is renamed over the note in one step. The note holds the old
    text or the new, never part of either.
  - It is checked against the base hash first, and fails with
    `ChangedOnDisk` as the desktop's does.
  - SHA-256 is worked out on the native side, so a file's bytes cross the
    bridge only when the page needs them.
  - Lists and reads come in batches. The trash, attaching under a free
    name, and hidden folders behave as on the desktop.
  - There is no watch of the folder. The plugin reports the app's own
    writes, as `OpfsFiles` does. When the app comes back on screen, the
    vault looks again, so a note another app changed through Files merges
    then.
- **Not `@capacitor/filesystem`.** Its native libraries write a file in
  place, with no sync to the disk, and its rename on Android deletes the
  target first. A crash in either leaves a note half written, or gone.
- **The index through `@capacitor-community/sqlite`**, behind the
  `Database` interface `SqliteStore` already takes, so the index, search
  and the sync store are the desktop's code.
  - Its native builds are SQLCipher's: `sqlcipher-android`, built with
    `SQLITE_ENABLE_FTS5`, and `SQLCipher.swift`, whose 4.20.0 framework
    lists `ENABLE_FTS5` among its compile options. Search's FTS5 table and
    its `unicode61 remove_diacritics 2` tokenizer work on both.
  - SQLCipher encrypts nothing here. The phone's encryption of the app's
    data covers the index, as the system's does on the desktop.
  - On iOS the databases are kept in `Library/CapacitorDatabase`, out of
    the Files app's sight.
  - The adapter opens each database in WAL mode with
    `synchronous = FULL`, so a commit survives a power cut.
  - It turns the plugin's rows, objects by column name, into the columns
    and rows the store reads, in the statement's order, and BLOBs into
    `Uint8Array`s. A test runs every statement of the store through it, so
    two columns of one name fail there, not on a phone.
  - Nether gives the plugin no upgrade statements, so `user_version`
    stays the store's own, as its migrations need.
- **Saved before the app leaves.** A note's Yjs document reaches the
  index within 250 ms of an edit, and its file within 2 s, as on the
  desktop. When the app leaves the screen, a new `NoteDocuments.flush()`
  saves every open note's document and writes its file at once, inside a
  background task. iOS gives such a task about 30 seconds at most.
- **Media** load from the URL Capacitor's `convertFileSrc` gives a file's
  native path, so images and PDFs never cross the bridge.
- **Taking a vault out.** On iOS the files are in Files. On both systems
  a ZIP export goes to the share sheet, and a note can go out as a
  Markdown copy. A documents provider, so Android's Files app shows the
  vaults as iOS's does, can come later.

### The page's fourth backend

**The mobile backend is the desktop's model on a phone**: vaults of its
own, each linked to a workspace or not, and any number of servers, each
signed in with a bearer token. It works with no account. It is
`mobileBackend.ts` in `apps/desktop/src`, loaded only in the mobile
build, as `webBackend.ts` is only in the web build. In a browser, the
mobile build uses the preview's backend, so the end-to-end tests drive
its pages.

| `Backend` | Desktop | Web | Mobile |
| --- | --- | --- | --- |
| `kind` | `desktop` | `web` | `mobile`, new |
| A vault's files | Go's `Vaults` | `OpfsFiles` | `DeviceFiles` over the plugin's `NetherVaults` |
| Its index | MyGO's SQLite plugin | SQLite's WebAssembly build in a worker | `@capacitor-community/sqlite` |
| `choose` and `open` | a folder the user picks | a workspace | `choose` gives null; the welcome screen asks for a name, and `open` makes that vault |
| `serverFetch` | Go's fetch | the browser's, with the cookie | `CapacitorHttp`'s native requests, given back as a `Response` |
| Tokens and the private key | the system's keychain, through Go | an `HttpOnly` cookie; the key in local storage | the Keychain or the Keystore |
| `loopback` | a loopback port | a page of the server's origin | the app's own scheme |
| `syncSocket` | MyGO's WebSocket | the browser's | the WebView's |
| Media | a loopback file server | blob URLs | `convertFileSrc` URLs |
| Exports | Go writes the file | downloads | the share sheet |
| Imports | Go reads the files | the browser's file picker | the WebView's file picker, without folders |
| AI | this device's providers | the server's relay | none yet |
| Updates | the app's own | the server's | the stores' |

The welcome screen offers a new vault on the phone, or a workspace from a
server, which becomes a vault linked to it, as the Sync dialog links one.

What the page gains, each member optional, so the other backends change
nothing:

- `onBackground(task)`, run as the app leaves the screen, within the
  background task, and `onResume(listener)`, run as it comes back.
- `captures`: the items the share sheet and the shortcuts hand the app,
  those that came before the page was ready included.
- `sendCopy(item)`: a note, or an export's file, to the system's share
  sheet.
- `LoopbackWait.open(url)`, in `server.ts`: opens the provider so that it
  comes back to this wait. `signInWithProvider` uses it where the backend
  gives one, and `openUrl` otherwise.

`features.ts`'s build gains `mobile`. Phones leave out what waits for a
later release, below, and what a phone has no use for: tabs and the
second pane, updates and keyboard shortcut settings. Webhooks and access
tokens stay in the desktop and web apps.

### Signing in

**Requests to a server are native.** `serverFetch` uses `CapacitorHttp`,
part of Capacitor's core, through its own request method; it does not
patch the page's `fetch`. Like Go's fetch on the desktop, it is outside
the page's CORS, and the server's API stays as it is.

**Sessions are bearer tokens**, as on the desktop. The page is not at the
server's origin, so a cookie would not reach it. The token, and the
account's private key for encrypted workspaces from
[ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md),
are kept by `@aparajita/capacitor-secure-storage`:

- on iOS in the Keychain, readable after the first unlock, on this device
  only, and never synced to iCloud Keychain;
- on Android sealed with AES-GCM under a key in the Android Keystore. The
  app's backup rules leave the sealed values out, since their key never
  leaves the phone: a restored app signs in again.

The servers signed in to, with their accounts and without their tokens,
are kept beside the list of vaults.

**Passwords and email codes** work as on the desktop. The code's field
asks for a one-time code, so the system can offer one from Mail or
Messages.

**A provider, and single sign-on, come back to the app's own scheme.**

- The return address is `io.github.fzn0x.nether:/sign-in/provider`, a
  private-use scheme named after the app's identifier, as RFC 8252 asks.
- The server's `mayReturnTo` accepts that exact address, beside a
  loopback address and the server's own origin. ADR 0080's flows use the
  same check, so single sign-on works from phones with no change of its
  own. Admins register nothing new: providers see only the server's
  callback.
- On iOS, the plugin's `SignIn` opens the provider in
  `ASWebAuthenticationSession`, the system's sign-in sheet, which takes
  the scheme back itself, so no other app can.
- On Android, `@capacitor/browser` opens it in a Custom Tab. An intent
  filter takes the scheme back, and `@capacitor/app` hands its address to
  the page. A tab closed without signing in ends the wait as cancelled.
- PKCE stands as before: an app that took the scheme would hold a code it
  cannot redeem.

**Release builds speak only HTTPS**, as the self-hosting guide asks.
Debug builds may reach plain HTTP on the emulator's host, for
development.

### The share sheet and quick capture

**Shared to Nether.**

- **Android**: intent filters take text, links, images and PDFs, one or
  several. The plugin's `Inbox` copies each file from its content address
  into the app's cache, and hands the page the items, which open the
  capture sheet.
- **iOS**: a share extension of Nether's own, in Swift, shows a small
  native sheet: what is shared, the vault it goes to, and Save. It loads
  no WebView, as an extension has little memory. It writes the item and
  its files to an inbox in an App Group the app and the extension share,
  and the app files the inbox as it opens or comes back. The app writes
  the vaults' names and IDs to the App Group, for the sheet to offer.

**Where a capture goes.** A capture becomes a new note in its vault's
capture folder, `Inbox` unless the vault's settings name another.

- Its title is the shared page's title, or the text's first line, or the
  time.
- Its properties are `source`, for a shared link, and `created`.
- Shared files are attached beside it and embedded in it.
- It goes to the vault opened last, unless the sheet's choice says
  otherwise. With no vault yet, the sheet makes one first.

**Quick capture.** `@capawesome/capacitor-app-shortcuts` gives the app's
icon four shortcuts, Android's app shortcuts and iOS's Home Screen quick
actions:

- **Capture** opens the capture sheet at once, before the vault's index
  loads: the sheet writes a file, which the vault indexes as it opens.
- **New note**, **Today's note** and **Search** open the last vault at
  those commands.

There is no widget in the first release. A widget is native interface
twice, WidgetKit's and Android's, and the shortcuts and the share sheet
already capture.

**Shared from Nether.** `@capacitor/share` sends a note out as Markdown
text, or as its file, under **Send a copy**, apart from the Share dialog,
which shares with people. Exports use it too:

- a ZIP of the vault, a folder or a note, which the plugin writes from the
  vault's files, as Go does on the desktop, with `java.util.zip` on
  Android and ZIPFoundation on iOS;
- a database's CSV.

The share sheet then offers Save to Files, mail, or any app. A PDF export
waits, as the WebViews cannot print to a file.

### What the first release has

| Feature | First release | Later |
| --- | --- | --- |
| Editor | The block editor, slash commands, live Markdown, every rich block, embeds, math and diagrams; source mode | Vim mode stays on the desktop |
| Writing on a phone | A bar of formatting and block actions above the keyboard | |
| Links | Wiki links, block and heading links, backlinks, unlinked mentions, aliases, tags, the outline | |
| Search | The quick switcher and full-text search, offline | Search by meaning, with AI |
| Notes | Properties, templates, periodic notes, folders and the page tree, trash, history | |
| Databases | Every view opens. Table, board, list and gallery are laid out for phones; calendar and timeline scroll sideways | Phone layouts for calendar and timeline |
| Query blocks, buttons and triggers | Yes, as the built-in plugins they are | |
| Sync and collaboration | Sync, encrypted workspaces, co-editing, comments, mentions, spaces, members, share links, publishing | Push notifications |
| Import | ZIP, Markdown, web pages and CSV, through the file picker | Folders |
| Export | ZIP and CSV through the share sheet; Send a copy | PDF |
| PDFs | Reading, with their highlights shown | Highlighting by touch |
| Canvas | A canvas file opens to a notice, and syncs untouched | Viewing, then editing, by touch |
| Graph view | | The local graph first, once measured on a phone |
| Plugins | The built-in ones | A vault's plugins and the directory; App Review's guideline 4.7 allows JavaScript plug-ins on conditions to read first |
| AI | Hidden, as with no provider | Its own part: providers, keys in the Keychain, and streamed requests outside CORS |
| Themes and snippets | Yes | |

**Phones and tablets.** The layout follows the page's width, not the
device. Under 40rem, 640 CSS pixels, the width the page already stacked
at:

- one note at a time, under a bar with the drawer's button, the note's
  title, the quick switcher and the palette, without tabs or a second
  pane;
- the sidebar becomes a drawer, opened by that button, which closes as a
  note opens, on Escape, or with a press beside it;
- menus and dialogs become sheets from the bottom, above the on-screen
  keyboard;
- a block's handle has no room beside the text, so the keyboard's bar
  moves, duplicates and deletes the block with the caret;
- in the apps, from part 2, the back button and the back gesture close
  what is open, then go back a note;
- the page keeps clear of notches and system bars by the CSS environment's
  safe areas, which Capacitor 8's System Bars sets on Android.

Wider, as on a tablet, the desktop layout stays. Touch-sized targets
follow the pointer, not the width: on a coarse pointer, at any width.

The phone's parts load only at a phone's width: the bar and the
keyboard's bar are chunks of their own, and their styles sit under media
queries, so the desktop app's memory does not grow with them.

**Targets.** On a mid-range phone, such as a Samsung Galaxy A35 with 6 GB
or an iPhone 13, in a release build, with the reference vault on the
phone. The desktop's limits hold where a phone can meet them. The others
are this record's, to be confirmed by the first numbers:

| Target | Phone | Section 7, on a laptop |
| --- | --- | --- |
| Opening to the last note, cold, median of 5 | 1.5 s at 5,000 notes; 3 s at 50,000 | 1.5 s at 50,000 |
| The capture sheet ready, cold | 1 s | |
| Switching notes, p95 | 100 ms | 100 ms |
| Typing, key to frame, p95 | 16 ms | 16 ms |
| Title search, p95 | 100 ms | 50 ms |
| Full-text search, p95 | 300 ms | 300 ms |
| Idle memory after 60 s, the app's processes together, median of 5 | 300 MB | 300 MB |

**How they are measured**: before each gate, and in each change that may
cost time, never in CI, as
[ADR 0017](0017-measure-performance-before-each-gate-not-in-ci.md) has
it.

- `pnpm --filter @nether/perf android` drives a `perf` build over adb:
  optimized as a release, with web debugging on. On its first run it
  writes the reference vault from `@nether/vault-generator` into the app
  through the app's own plugin.
- Opening is timed from the process's start to the page's marks:
  `backend.mark` writes each one to the system log with the time since
  the process started, where the harness reads it.
- Switching, typing and search run the desktop's `perf:ui` scenarios in
  the WebView, reached through Chromium's DevTools protocol over adb.
- Memory is the PSS of the app's process and of its WebView's renderer,
  which Android runs as a process of its own, summed, from
  `dumpsys meminfo` after 60 s idle.
- Each change is compared with main on the Android emulator, on the
  maintainer's machine. The table's numbers come from a phone before the
  gate.
- iPhones are measured with a Mac at the gate, with Instruments' launch
  timing and the memory of the app and its WebContent process. Until
  then, the reports say the Android numbers stand alone.

If opening misses its target at 50,000 notes because of the plugin's
bridge, a SQLite plugin of Nether's own, giving rows as arrays, is the
next step, before any feature moves.

### Sync

**Sync is the same engine** as the desktop's and the web's,
`@nether/sync-client`, over the WebView's WebSocket: Hocuspocus for plain
workspaces, and the relay for encrypted ones.

**Phones sync while the app is on screen.**

- **iOS** suspends the app soon after it leaves, which ends its sockets.
  A background task gives about 30 seconds. Background refresh runs when
  the system picks, briefly, and never runs the page.
- **Android** defers background work in Doze. Periodic work runs at most
  every 15 minutes, and a lasting foreground service needs a notification
  for as long as it runs.
- **Capacitor's Background Runner** runs a separate JavaScript context,
  with no WebSocket and none of the app's plugins, as its
  [documentation](https://capacitorjs.com/docs/apis/background-runner)
  says. The engine needs both, so it cannot run there.

So the app:

- on leaving the screen, saves every open note, then gives the engine
  what is left of the background task to send what is pending, through
  `@capawesome/capacitor-background-task`;
- on coming back, starts the vault's sync again at once, rather than
  waiting out the socket's backoff, and catches up by number, as opening
  a vault does;
- reconnects when the network returns, on the page's `online` event.

There is no sync in the background and no push in the first release.
Push needs Apple's and Google's services, or UnifiedPush on Android, and
is a decision of its own.

**Edits made offline** are the desktop's case.

- Each is in its note's document in the index, and in its file.
- The engine keeps the notes changed and not sent in its store, so the
  list survives the app being ended.
- When it reconnects, it sends them and catches up. Yjs merges text with
  no conflict to resolve. Notes made, moved or removed on both sides meet
  by their base, as
  [ADR 0037](0037-a-vault-syncs-through-a-document-of-its-paths-and-its-notes-documents.md)
  has it.
- A session that ended while away asks to sign in again, and keeps what
  is pending.

When iOS ends the WebView's process while the app is away, the app
reloads the page, which opens the last note. What the page held was saved
as the app left.

### Build and CI

- `pnpm --filter @nether/mobile build` builds the page and runs
  `cap sync`. Gradle and Xcode build the apps from there.
- **Android, on Linux**: CI builds the debug APK with Gradle's wrapper on
  JDK 21, runs the plugin's JVM tests and the license check, and keeps
  the APK as an artifact.
- **The Android emulator**: CI starts an Android 15 emulator with
  `ReactiveCircus/android-emulator-runner` and runs the smoke test below.
  Runners cost nothing for a public repository, and the job takes
  minutes.
- **iOS, on macOS**: CI builds the app for the simulator, signed to run
  locally, which needs no account. It runs the plugin's Swift tests, and
  starts the app in a simulator with a vault, waiting for the page's marks
  until the vault's notes are read, then finds the note in the index. The
  share extension builds too. Its App Group needs signing, so it is tried
  on a device, with the maintainer's account. macOS runners cost more than
  Linux's, so this runs only for changes to the app, its plugin or the page.
- **Release builds** are unsigned until the maintainer adds the signing
  keys as secrets.

**The license scan covers what ships in each app**, not only npm's
packages:

- the npm packages, as now, the Capacitor plugins among them;
- the Android app's Gradle dependencies, with Cash App's `licensee`
  Gradle plugin, which fails the build on a license outside ADR 0001's
  list. SQLCipher's POM names its license by an address only, so it gets
  a reviewed entry, as `reviewed` holds them for npm;
- the iOS app's Swift packages, read from `Package.resolved`, each known
  by its license file, as the script knows Go modules now.

The apps ship their native dependencies' notices, as BSD-3-Clause asks of
SQLCipher's binaries.

### Tests

- **Unit tests for the mobile backend**, with the plugins stood in for:
  - the SQLite adapter: column order, BLOBs, a transaction all or none,
    every statement of the store;
  - the files adapter: batches, paths, `ChangedOnDisk` from the plugin's
    error;
  - the native fetch as a `Response`: status, headers, text, JSON and
    bytes;
  - the scheme's handoff: the query read back, a tab closed;
  - filing captures: titles, properties, folders and attachments' names;
  - leaving the screen: every note saved before the background task ends.
- **The server's tests** for `mayReturnTo`: the app's address, and only
  at that path.
- **The plugin's native tests**, in Java on the JVM and in Swift on the
  simulator, run the cases of the `MemoryFiles` and `OpfsFiles` tests, and
  a write cut short at each step, which must leave the old text or the
  new.
- **Playwright against the mobile build** at a phone's viewport: Chromium
  as a Pixel 7 and WebKit as an iPhone 15, with touch, light and dark,
  left to right and right to left. It covers the drawer, the sheets, the
  keyboard's bar, the capture sheet and a share handed in through the
  preview's hooks. Axe checks every screen, as
  [ADR 0015](0015-check-accessibility-and-lay-out-by-direction.md) has it,
  and a check measures every control.
- **The emulator smoke test**, in CI: install the debug APK, attach
  Playwright to the WebView through the DevTools protocol over adb, make
  a vault and a note, and type. Then:
  - send the app home and force it to stop: the text is there on the next
    start;
  - force it to stop a second after typing, without leaving: the text is
    there too.

### Accessibility and languages

- **Targets**: on a coarse pointer, every control takes at least 48 by 48
  CSS pixels, with room between. That is Android's 48 dp, above Apple's
  44 points and WCAG 2.2's 24 pixels. In a WebView laid out at the
  device's width, a CSS pixel is a dp, or a point.
- **Screen readers**: TalkBack reads the WebView through Chromium's
  accessibility tree, and VoiceOver through WebKit's, both from the
  page's roles and labels, which axe already checks. The new parts have
  them too: the drawer's button and region, each sheet as a dialog that
  keeps focus, the keyboard's bar as a labelled toolbar, and the capture
  sheet. Each part is tried by hand with TalkBack and VoiceOver before it
  merges, by a checklist in the guide.
- **No gesture alone**: what a swipe or a drag does, a button does too,
  as WCAG 2.2 asks. A block moves up and down from its menu, or on a
  phone from the keyboard's bar; a property from its handle's menu; and a
  board's card from its own.
- **Text size**: the page follows the system's text size, on both
  systems.
- **The native parts**: the share extension's sheet has labels and
  follows Dynamic Type. The shortcuts have short and long labels.
- **Languages**: the page's strings stay in `messages.ts`. Native strings
  are in each platform's string files, translated the same way. Android
  declares right-to-left support, and SwiftUI lays out by direction.

### Parts

Each part is one pull request from `origin/main`, ships something usable,
and updates the guide, the roadmap and the README as it goes.

1. **The phone layout, in the web app first.** The drawer, the sheets,
   one pane, the keyboard's bar, touch-sized targets, a button for every
   drag, and database views laid out for phones, with Playwright at phone
   viewports in Chromium and WebKit. The web app becomes usable in a
   phone's browser. This record lands with it. The back button waits for
   part 2, where the app owns it: a web page's back gesture leaves it.
2. **The Android app, with vaults on the phone.** `apps/mobile` and its
   Android project; the mobile backend's vaults, with the plugin's
   `NetherVaults` in Java and the SQLite adapter; saving as the app leaves and
   looking again as it returns; imports and media. CI's debug APK, the
   Gradle license check and the emulator smoke test, and
   the Android harness in `tools/perf`, with its first numbers in the pull
   request.
   An offline notes app on Android, installed from CI's APK.
3. **The iOS app, with vaults on the phone.** The iOS project, the
   plugin's `NetherVaults` in Swift, vaults in Files, the Swift packages'
   license check, and CI's simulator build and start. The same app on
   iOS, in the simulator.
4. **Signing in and sync, on both.** Native requests; tokens and keys in
   the Keychain and the Keystore; passwords, codes, providers and single
   sign-on through the app's scheme, with `mayReturnTo` taking it; a
   workspace opened as a linked vault; sync on and off the screen. The
   phone syncs with the user's server.
5. **Quick capture and the share sheet.** The shortcuts, the capture
   sheet, Android's intent filters, iOS's share extension and its App
   Group inbox, Send a copy, and ZIP and CSV exports through the share
   sheet.

A follow-up issue then holds what needs the maintainer's accounts, as
#160 does for the clipper: signing, the stores, the App Group, and App
Store Connect's export compliance answers, naming SQLCipher, which the
apps carry, and libsodium, which encrypts end to end. The roadmap's item
is ticked when part 5 merges, saying so.

### Dependencies

| Package | Version | License | For | Kept by |
| --- | --- | --- | --- | --- |
| `@capacitor/core`, `cli`, `android` and `ios` | 8.6.0, 2026-10-28: pnpm waits seven days for 8.6.2 | MIT | The apps | Ionic, part of OutSystems |
| `@capacitor/app` | 8.1.2, 2026-10-02 | MIT | Leaving and coming back, the back button, the scheme's return | Ionic |
| `@capacitor/browser` | 8.0.5, 2026-10-02 | MIT | Custom Tabs for providers on Android | Ionic |
| `@capacitor/share` | 8.0.3, 2026-10-02 | MIT | Send a copy, and exports | Ionic |
| `@capacitor/keyboard` | 8.0.6, 2026-10-02 | MIT | The bar above the keyboard | Ionic |
| `@capacitor-community/sqlite` | 8.1.1, 2026-08-06 | MIT | The index | Robin Genz, of Capawesome; Swift packages since 8.1.0 |
| `@aparajita/capacitor-secure-storage` | 8.0.1, 2026-09-23 | MIT | Tokens and the private key | One maintainer |
| `@capawesome/capacitor-app-shortcuts` | 8.0.3, 2026-10-09 | MIT | Quick capture | Robin Genz, of Capawesome |
| `@capawesome/capacitor-background-task` | 8.0.3, 2026-09-02 | MIT | Time to save and send | Robin Genz, of Capawesome |
| `app.cash.licensee`, a Gradle plugin for the build only | 1.14.1, 2025-10-09 | Apache-2.0 | The license scan | Cash App |

What they bring, all on ADR 0001's list: SQLCipher for Android 4.17.0
and SQLCipher.swift 4.x, under BSD-3-Clause; ZIPFoundation and
keychain-swift, MIT; AndroidX libraries, Apache-2.0. `jeep-sqlite` 2.8.0,
MIT, comes for the SQLite plugin's web side, with `sql.js`,
`localforage`, `jszip` and `@stencil/core`; the mobile build never
bundles it. The plugin of Nether's own names ZIPFoundation itself, rather
than counting on the SQLite plugin to bring it.

## Alternatives

- **The WebView's storage, as the web app keeps it**: a workspace in the
  private file system, its index in SQLite's WebAssembly build. Most code
  reused, and no bridge for queries. But the system may reclaim a
  WebView's storage, edits would live there before sync, and the files
  would be nowhere the user can see.
- **`@capacitor/filesystem` for the files.** Official and maintained, but
  neither atomic nor synced to the disk, as above.
- **Another SQLite plugin.**
  - `@capgo/capacitor-fast-sql` 8.3.4, MPL-2.0, answers queries through a
    local HTTP server, which every app on the phone can reach behind a
    token, and brings SQLCipher too.
  - `@microbit/capacitor-sqlite-vanilla` 0.2.0, MIT, says itself it has
    served one app. On iOS it uses the system's SQLite, which promises no
    FTS5.
  - Capawesome's own SQLite plugin is commercial.
  - A plugin of Nether's own is the most native code to keep. It is the
    next step if the bridge proves too slow.
- **The web app on phones, installed from the browser.** iOS gives such a
  page no place in the share sheet and may clear its storage, and it
  reaches one server only. Part 1 makes it usable all the same.
- **Claimed https links for providers.** Universal Links and App Links
  name their domains in the app's build, before any self-hosted server's
  domain is known.
- **A loopback address, as on the desktop.** RFC 8252 names it for
  desktop apps. A phone may suspend the app while the browser is in
  front, and a port on the phone is open to every app on it.
- **CORS on the server for the apps' origins.** ADR 0036 declined it for
  the desktop app. Native requests leave the server as it is, at the cost
  of streamed answers, which only AI needs.
- **A cookie session**: the page is not at the server's origin.
- **`capacitor-secure-storage-plugin` 0.14.2**, MIT and maintained. Its
  Keychain items are readable after the first unlock but not bound to the
  device, so an encrypted backup carries them to another, and it has no
  option against that.
- **The Keychain and Keystore calls in Nether's own plugin.** A few dozen
  lines in each language, beside native code the plugin has anyway. Not
  now, while `@aparajita/capacitor-secure-storage` is maintained; if it
  goes unmaintained, they move there.
- **A share plugin.** `@capgo/capacitor-share-target` 8.0.68, MPL-2.0,
  and `@mindlib-capacitor/send-intent` 8.0.6, MIT, both leave the iOS
  share extension to the app, and read what it saves in a format of their
  own. The first releases almost daily. The second's last release is from
  January 2026, with a fix since that is unreleased.
  `capacitor-share-extension` 7.0.0 is for Capacitor 7. Nether's own code
  is short on Android, and needed on iOS anyway.
- **Sync in the background through the Background Runner**: a separate
  context, without sockets or plugins.
- **A widget now**: two native interfaces, for a capture the shortcuts
  already give.
- **React Native, or native apps**: the architecture chose Capacitor, one
  UI for every client.

## Consequences

- Nether keeps Swift and Java beside Go: the plugin, the share
  extension and the two projects, with their tests in CI.
- The apps carry SQLCipher, though they encrypt nothing with it. With the
  end-to-end encryption they do perform, App Store Connect's export
  compliance questions need the maintainer's answers.
- A phone syncs only while Nether is on screen. A phone left closed for a
  week catches up when it is opened, and others wait until then for its
  edits.
- Android's vaults are seen only through Nether, its exports and sync,
  until a documents provider shows them in Files.
- On iOS, another app's edit to a note through Files, while Nether stays
  on screen as it can beside it on an iPad, shows when Nether next comes
  back, or when it next writes that note, merging it then.
- The server accepts one more return address. A fork of the apps with
  another identifier needs its server to accept that scheme too.
- Each part's pull request measures on the emulator; the gate measures on
  phones.
- Revisit the SQLite bridge if opening misses its target at 50,000 notes;
  `@capacitor-community/sqlite` or the secure storage plugin if their
  maintenance stops, the second having one maintainer; and sync in the
  background when the platforms or the engine allow a native catch-up.
