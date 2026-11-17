# @nether/mobile

The Nether apps for Android and iOS
([ADR 0087](../../docs/adr/0087-the-mobile-apps-run-the-shared-page-in-capacitor-with-each-vaults-files-and-index-on-the-phone.md)):
the desktop app's page in Capacitor, with each vault Markdown files on the
phone and its index in SQLite.

- **The page** is `apps/desktop/src`, built with `VITE_NETHER_TARGET=mobile`
  into `dist/`, which Capacitor copies into the app. The app serves it from
  its own files. `apps/desktop/src/mobileBackend.ts` is its backend.
- **A vault** is a folder with its ID in `.nether/vault.json`, as the
  desktop app keeps it: on Android in the app's own files, `vaults/<name>/`;
  on iOS in the app's Documents, which the Files app shows under On My
  iPhone, Nether. The app's own plugin, `NetherVaults`, lists, reads with
  each file's SHA-256, and writes in one step: to a hidden temporary file
  beside the note, synced to the disk, renamed over it. `DeviceFiles` in
  `packages/storage` does the rest. It is Java on Android
  (`android/app/src/main/java/io/github/fzn0x/nether/`) and Swift on iOS,
  the package in `plugin/`, linked as `@nether/mobile-plugin` so Capacitor
  adds it to the app as it does each plugin from npm. Its core, `Vaults`, is
  plain Foundation, with the same tests as the Java.
- **The index** is SQLite through `@capacitor-community/sqlite`, in WAL mode
  with full syncs (`apps/desktop/src/mobileIndex.ts`).
- **Leaving the screen**, the page saves every open note at once, in the
  time the system gives. **Coming back**, the vault looks at its folder
  again. **The back button** closes a menu, a dialog or the drawer, as
  Escape does, then puts the app away.
- **Servers** are reached natively, through `CapacitorHttp`, outside the
  page's CORS (`mobileHttp.ts`). The servers signed in to are listed beside
  the vaults, in `servers.json`; each session's token and the account's
  private key are kept by `@aparajita/capacitor-secure-storage`: in the iOS
  Keychain, after the first unlock and on this device only, and on Android
  sealed under a key from the Keystore, which `backup_rules.xml` and
  `data_extraction_rules.xml` leave out of backups (`mobileServers.ts`).
- **A provider's sign-in** comes back to the app's own scheme,
  `io.github.fzn0x.nether:/sign-in/provider`: on iOS the plugin opens it in
  `ASWebAuthenticationSession`, which takes the scheme back itself; on
  Android a Custom Tab opens it, and the activity's intent filter takes the
  scheme back (`mobileSignIn.ts`).
- **Sync** runs while the app is on screen: leaving, the engine sends what
  is pending once the notes are saved; coming back, or back online, it
  starts again at once (`useSync.ts`). Release builds speak only HTTPS;
  the debug build alone reaches plain HTTP, on the emulator's host.
- Exports through the share sheet come in the next part; the build leaves
  them out until then.

## Build

Android needs JDK 21 and the Android SDK, with `ANDROID_HOME` set.

```sh
pnpm --filter @nether/mobile build                  # the page into dist/, copied into android/
cd apps/mobile/android
./gradlew assembleDebug                             # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest                         # the plugin's tests, on the JVM
./gradlew licensee                                  # every library's license, against ADR 0001
```

Debug builds sign with the SDK's own debug key. Release builds are
unsigned: no key is ever in the repository.

iOS needs macOS with Xcode 26. The same build copies the page into
`ios/`, and writes the app's package of plugins, `ios/App/CapApp-SPM`,
which is committed as it makes it.

```sh
pnpm --filter @nether/mobile build                  # the page into dist/, copied into ios/
cd apps/mobile/ios/App
xcodebuild build -project App.xcodeproj -scheme App \
  -destination "generic/platform=iOS Simulator" CODE_SIGN_IDENTITY=-
cd ../../plugin
xcodebuild test -scheme NetherMobilePlugin \
  -destination "platform=iOS Simulator,name=iPhone 17"  # the plugin's tests
```

The simulator's builds are signed to run locally, with no account. To run
on a phone, open `ios/App/App.xcodeproj` and choose your own team: no
signing identity, team or profile is ever in the repository.
`App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
pins the Swift packages the app ships, as `pnpm-lock.yaml` pins npm's.

`pnpm --filter @nether/mobile icons` renders the app icons from
`apps/desktop/icon.svg`: the launcher icons for Android 7, whose later
versions draw the adaptive icon in
`res/drawable-v24/ic_launcher_foreground.xml`, and iOS's square.

## Test

```sh
pnpm --filter @nether/mobile smoke [path/to/app-debug.apk]
```

installs the APK on the device or emulator adb has, makes a vault and a
note through the page, which Playwright drives in the app's WebView, and
checks that what was typed is there after the app is ended: from the home
screen, and on screen a moment after typing. Then it starts a server on
this machine (`scripts/sync-server.ts`, PostgreSQL in its process), which
the emulator reaches as `10.0.2.2`, signs in with a password, opens the
workspace from the first screen, and checks that the server's note comes
to the phone, that a note typed there reaches the server, and that, ended
and started again, the app is still signed in and gets the server's next
note. CI runs it on an Android 15 emulator.

```sh
pnpm --filter @nether/mobile smoke:ios path/to/App.app [simulator UDID]
```

installs the app in a simulator with a vault of one note, the vault it had
open last, starts it, and waits for the page's marks in the system's log:
the vault open and its notes read. Then the vault's index, in the app's
SQLite, holds the note with the size and time the plugin listed, and
search finds it. CI runs it on macOS, only for changes to the app or its
page.

`pnpm --filter @nether/perf android` measures opening to the last note and
idle memory on a `perf` build ([tools/perf](../../tools/perf/README.md)).
