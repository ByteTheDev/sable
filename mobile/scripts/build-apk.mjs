// Builds the debug APK: web bundle, Capacitor sync, Gradle, then copies it to release-mobile/.
//   node scripts/build-apk.mjs   (from mobile/; needs ANDROID_HOME and a JDK 21 in JAVA_HOME)
// Heavy: takes scratch/heavy.lock for the Gradle step so it never runs beside another build.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const repo = path.join(root, '..');
const lock = path.join(repo, 'scratch', 'heavy.lock');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', env: process.env });

run('npx tsc --noEmit -p tsconfig.json');
run('npx vite build');
run('npx cap sync android');

if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 3 * 60_000) {
  console.error('scratch/heavy.lock is held by another build; try again in a moment.');
  process.exit(1);
}
mkdirSync(path.dirname(lock), { recursive: true });
writeFileSync(lock, `mobile apk build ${new Date().toISOString()}\n`);
try {
  run(process.platform === 'win32' ? '.\\gradlew.bat assembleDebug --no-daemon -q' : './gradlew assembleDebug --no-daemon -q', path.join(root, 'android'));
} finally {
  rmSync(lock, { force: true });
}
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const out = path.join(repo, 'release-mobile');
mkdirSync(out, { recursive: true });
copyFileSync(apk, path.join(out, 'sable-mobile-debug.apk'));
console.log(`APK: ${path.join(out, 'sable-mobile-debug.apk')} (${(statSync(apk).size / 1e6).toFixed(1)} MB)`);
