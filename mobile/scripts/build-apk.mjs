// Builds the debug APK: web bundle, Capacitor sync, Gradle, then copies it to release-mobile/.
//   node scripts/build-apk.mjs   (from mobile/; needs ANDROID_HOME and a JDK 21 in JAVA_HOME)
// Heavy: the Gradle step runs under scratch/heavy.lock. Another agent's lock younger than 15 minutes
// stops the build; a lock that starts with SABLE_LOCK_OWNER (default "mobile apk build") is ours and
// is kept as it was; a lock this script wrote is removed again at the end.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const owner = process.env.SABLE_LOCK_OWNER ?? 'mobile apk build';
const held = existsSync(lock) ? readFileSync(lock, 'utf8') : '';
const ours = held.startsWith(owner);
if (held && !ours && Date.now() - statSync(lock).mtimeMs < 15 * 60_000) {
  console.error(`scratch/heavy.lock is held (${held.trim()}); try again later.`);
  process.exit(1);
}
mkdirSync(path.dirname(lock), { recursive: true });
const wrote = !ours;
if (wrote) writeFileSync(lock, `${owner} ${new Date().toISOString()}\n`);
try {
  run(process.platform === 'win32' ? '.\\gradlew.bat assembleDebug --no-daemon -q' : './gradlew assembleDebug --no-daemon -q', path.join(root, 'android'));
} finally {
  if (wrote && existsSync(lock) && readFileSync(lock, 'utf8').startsWith(owner)) rmSync(lock, { force: true });
}
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const out = path.join(repo, 'release-mobile');
mkdirSync(out, { recursive: true });
copyFileSync(apk, path.join(out, 'sable-mobile-debug.apk'));
console.log(`APK: ${path.join(out, 'sable-mobile-debug.apk')} (${(statSync(apk).size / 1e6).toFixed(1)} MB)`);
