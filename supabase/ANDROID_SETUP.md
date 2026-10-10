# Turning this into an Android APK (Capacitor)

I've already prepped the project (`capacitor.config.json`, `vite.config.js`
fix, and the native plugin dependencies in `package.json`). Everything below
needs to run on **your own machine** — I don't have network/Android Studio
access from here to install packages or build an APK myself.

## Prerequisites (one-time, on your machine)
- Node.js 18+
- [Android Studio](https://developer.android.com/studio) (installs the
  Android SDK + an emulator, or plug in a real phone with USB debugging on)
- A JDK (Android Studio bundles one — no separate install needed)

## 1. Install dependencies
```bash
npm install
```
This pulls in Capacitor core/CLI/Android, plus the plugins for camera, file
access, push notifications, and fingerprint login that are already listed in
`package.json`.

## 2. Add the Android platform (one-time)
```bash
npm run android:add
```
This creates an `android/` folder — a real, native Android Studio project
that wraps your web app. It gets committed to git like any other source.

## 3. Build the web app and sync it into the Android project
```bash
npm run android:build
```
Run this every time you change the React/Vite app — it rebuilds `dist/` and
copies it into `android/app/src/main/assets/public`.

## 4. Open in Android Studio and run/build
```bash
npm run android:open
```
From Android Studio you can:
- Press ▶ Run to test on an emulator or a plugged-in phone
- **Build → Generate Signed Bundle / APK** to produce a shareable `.apk`
  (no Play Store needed — just send the file, the recipient enables
  "Install from unknown sources" once)

## 5. Wiring up the native features
The plugins are installed, but each needs a couple of lines of code to
actually replace the web-only fallback. I'd tackle these one at a time,
in this order — happy to do the code for whichever you want next:

| Feature | Plugin (already added) | Notes |
|---|---|---|
| Camera | `@capacitor/camera` | Replaces `<input type="file" capture>` with the native camera picker for document uploads |
| File upload/download | `@capacitor/filesystem` | Needed so downloaded PDFs/receipts save to the device instead of just opening in-browser |
| Fingerprint login | `@aparajita/capacitor-biometric-auth` | Gate app open (or a specific screen) behind Face/Fingerprint unlock |
| Push notifications | `@capacitor/push-notifications` | Needs a Firebase project (free tier is fine) — optional, skip for v1 |
| Voice/video call mic & camera access | none (native code, no plugin) | The Android WebView needs its own permission grant on top of the Android Settings toggle, or calls fail with a cryptic "Cannot read properties of undefined (reading 'replace')" error even when Microphone is allowed in Settings — see `android-webrtc-permissions/README.md` for the exact 2-file patch, applied right after step 2 below (`npm run android:add`) |

## 6. App icon & splash screen
Android Studio ships with placeholder icons. Once you have a logo, the
easiest path is:
```bash
npm install -D @capacitor/assets
npx capacitor-assets generate
```
Drop a 1024×1024 `icon.png` and a `splash.png` in `resources/` first — the
command generates every density/size Android needs automatically.

## What I already fixed for you
- `vite.config.js` — set `base: './'` so asset paths resolve correctly
  inside Capacitor's WebView (a very common cause of a blank white screen
  on first launch otherwise). This doesn't affect your normal web hosting.
- `capacitor.config.json` — app ID `com.oneinfinity.erp`, app name
  "One Infinity", pointed at the `dist/` build output.
