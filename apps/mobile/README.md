# @nether/mobile

The Nether apps for Android and iOS
([ADR 0087](../../docs/adr/0087-the-mobile-apps-run-the-shared-page-in-capacitor-with-each-vaults-files-and-index-on-the-phone.md)):
the desktop app's page in Capacitor, with each vault Markdown files on the
phone and its index in SQLite. This is the Android app; iOS comes next.

- **The page** is `apps/desktop/src`, built with `VITE_NETHER_TARGET=mobile`
  into `dist/`, which Capacitor copies into the app. The app serves it from
  its own files. `apps/desktop/src/mobileBackend.ts` is its backend.
- **A vault** is a folder in the app's own files, `vaults/<name>/`, with its
  ID in `.nether/vault.json`, as the desktop app keeps it. The app's own
  plugin, `NetherVaults` (`android/app/src/main/java/io/github/fzn0x/nether/`),
  lists, reads with each file's SHA-256, and writes in one step: to a hidden
  temporary file beside the note, synced to the disk, renamed over it.
  `DeviceFiles` in `packages/storage` does the rest.
- **The index** is SQLite through `@capacitor-community/sqlite`, in WAL mode
  with full syncs (`apps/desktop/src/mobileIndex.ts`).
- **Leaving the screen**, the page saves every open note at once, in the
  time the system gives. **Coming back**, the vault looks at its folder
  again.
- Signing in and sync, and exports through the share sheet, come in later
  parts; the build leaves them out until then.

## Build

It needs JDK 21 and the Android SDK, with `ANDROID_HOME` set.

```sh
pnpm --filter @nether/mobile build                  # the page into dist/, copied into android/
cd apps/mobile/android
./gradlew assembleDebug                             # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest                         # the plugin's tests, on the JVM
./gradlew licensee                                  # every library's license, against ADR 0001
```

Debug builds sign with the SDK's own debug key. Release builds are
unsigned: no key is ever in the repository.

`pnpm --filter @nether/mobile icons` renders the launcher icons for
Android 7 from `apps/desktop/icon.svg`; later versions draw the adaptive
icon in `res/drawable-v24/ic_launcher_foreground.xml`.

## Test

```sh
pnpm --filter @nether/mobile smoke [path/to/app-debug.apk]
```

installs the APK on the device or emulator adb has, makes a vault and a
note through the page, which Playwright drives in the app's WebView, and
checks that what was typed is there after the app is ended: from the home
screen, and on screen a moment after typing. CI runs it on an Android 15
emulator.

`pnpm --filter @nether/perf android` measures opening to the last note and
idle memory on a `perf` build ([tools/perf](../../tools/perf/README.md)).
