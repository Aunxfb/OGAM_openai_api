/**
 * Fetches prebuilt native binaries for react-native-audio-api.
 *
 * The npm tarball ships headers only (`common/cpp/audioapi/external/include*`);
 * the `.a`/`.so`/framework binaries must be downloaded separately, otherwise
 * the Android NDK link fails (e.g. missing `external/android/arm64-v8a/libopusfile.a`).
 * This mirrors the upstream `download-prebuilt-binaries.sh` (same release TAG and
 * file list) in cross-platform Node, because `npm install` on Windows cannot run bash.
 *
 * Re-runs are cheap: a zip whose destination directory already exists is skipped,
 * so this is safe to run from `postinstall` on every install.
 *
 * Env overrides (used by tests, not needed in normal use):
 *   RN_AUDIO_PKG_DIR  - react-native-audio-api package root (default: node_modules copy)
 *   RN_AUDIO_LIB_URL  - release download base URL (default: the rn-audio-libs release)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

// Keep TAG in lockstep with node_modules/react-native-audio-api/scripts/download-prebuilt-binaries.sh
const TAG = 'v3.1.0';
const BASE_URL = process.env.RN_AUDIO_LIB_URL
  || `https://github.com/software-mansion-labs/rn-audio-libs/releases/download/${TAG}`;
const PKG_DIR = process.env.RN_AUDIO_PKG_DIR
  || path.join(__dirname, '..', 'node_modules', 'react-native-audio-api');

// darwin hosts may build iOS too, so they need the full set; other hosts only build Android.
const ZIPS = process.platform === 'darwin'
  ? ['android.zip', 'ffmpeg_ios.zip', 'iphoneos.zip', 'iphonesimulator.zip', 'jniLibs.zip', 'macosx.zip']
  : ['android.zip', 'jniLibs.zip'];

function destFor(zipName) {
  if (zipName === 'jniLibs.zip') {
    return path.join(PKG_DIR, 'android', 'src', 'main', 'jniLibs');
  }
  return path.join(PKG_DIR, 'common', 'cpp', 'audioapi', 'external', zipName.replace(/\.zip$/, ''));
}

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), destPath, redirectsLeft - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`download failed: HTTP ${status} for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(PKG_DIR)) {
    throw new Error(`react-native-audio-api not found at ${PKG_DIR} — run npm install first`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnaa-binaries-'));
  try {
    for (const zipName of ZIPS) {
      const destDir = destFor(zipName);
      if (fs.existsSync(destDir)) {
        console.log(`[fetch-audio-binaries] ${zipName} already present, skipping`);
        continue;
      }
      const url = `${BASE_URL}/${zipName}`;
      const zipPath = path.join(tmpDir, zipName);
      console.log(`[fetch-audio-binaries] downloading ${url}`);
      await download(url, zipPath);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      // bsdtar (Windows/macOS) and GNU tar both extract zips.
      execFileSync('tar', ['-xf', zipPath, '-C', path.dirname(destDir)], { stdio: 'inherit' });
      if (!fs.existsSync(destDir)) {
        throw new Error(`extracted ${zipName} but ${destDir} is still missing`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('[fetch-audio-binaries] done');
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[fetch-audio-binaries] ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { main, destFor, ZIPS };
