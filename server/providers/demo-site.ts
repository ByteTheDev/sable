/**
 * A tiny real web page for the Demo's `beforeafter` scenario: two files in a temp folder, served
 * on a free local port, so Sable's before / after captures a page that really changes. One per
 * session, kept while it is used and closed after a quiet quarter hour (or when the bridge exits).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The looks the scenario steps through, one per run. */
export const LOOKS = [
  { heading: 'Relay API', accent: '#5b8def', name: 'blue' },
  { heading: 'Every relay, at a glance', accent: '#e0794a', name: 'orange' },
  { heading: 'Relay status', accent: '#3fa37a', name: 'green' },
] as const;

export type Look = (typeof LOOKS)[number];

export const siteHtml = (look: Look) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>relay-api</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <nav><strong>relay</strong><span>Routes</span><span>Webhooks</span><span>Docs</span></nav>
  <main>
    <h1>${look.heading}</h1>
    <p>Sessions, webhooks and tokens for every service, in one place.</p>
    <a class="cta" href="#">Open the dashboard</a>
    <section>
      <div><b>25</b><span>tests passing</span></div>
      <div><b>184 ms</b><span>p95 latency</span></div>
      <div><b>3</b><span>webhook routes</span></div>
    </section>
  </main>
</body>
</html>
`;

export const siteCss = (look: Look) => `:root {
  --accent: ${look.accent};
  --ink: #16181d;
  --muted: #6b7180;
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: #f7f7f5; }
nav { display: flex; gap: 28px; align-items: center; padding: 22px 48px; border-bottom: 1px solid #e4e4e0; }
nav strong { margin-right: auto; font-size: 18px; }
nav span { color: var(--muted); font-size: 14px; }
main { max-width: 880px; padding: 72px 48px; }
h1 { margin: 0 0 14px; font-size: 52px; line-height: 1.08; letter-spacing: -0.02em; }
p { margin: 0 0 30px; color: var(--muted); font-size: 18px; max-width: 520px; }
.cta { display: inline-block; padding: 12px 22px; border-radius: 10px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
section { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 64px; }
section div { padding: 18px 20px; border-radius: 12px; background: #fff; border: 1px solid #e8e8e4; }
section b { display: block; font-size: 24px; color: var(--accent); }
section span { color: var(--muted); font-size: 14px; }
@media (max-width: 640px) {
  nav { padding: 18px 20px; gap: 16px; }
  main { padding: 40px 20px; }
  h1 { font-size: 36px; }
  section { grid-template-columns: 1fr; margin-top: 40px; }
}
`;

export interface DemoSite {
  url: string;
  dir: string;
  /** How many runs edited it (the next look is `LOOKS[(runs + 1) % LOOKS.length]`). */
  runs: number;
  read(file: 'index.html' | 'styles.css'): string;
  write(file: 'index.html' | 'styles.css', content: string): void;
}

const sites = new Map<string, { site: DemoSite; server: http.Server; timer?: NodeJS.Timeout }>();
const QUIET_MS = 15 * 60_000;

function close(sessionId: string) {
  const s = sites.get(sessionId);
  if (!s) return;
  sites.delete(sessionId);
  clearTimeout(s.timer);
  s.server.close();
  rmSync(s.site.dir, { recursive: true, force: true });
}

process.once('exit', () => {
  for (const id of [...sites.keys()]) close(id);
});

/** The session's page, started on first use. `fresh` is true when it was just started. */
export async function demoSite(sessionId: string): Promise<{ site: DemoSite; fresh: boolean }> {
  const known = sites.get(sessionId);
  if (known) {
    clearTimeout(known.timer);
    known.timer = setTimeout(() => close(sessionId), QUIET_MS);
    known.timer.unref?.();
    return { site: known.site, fresh: false };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-demo-site-'));
  writeFileSync(path.join(dir, 'index.html'), siteHtml(LOOKS[0]));
  writeFileSync(path.join(dir, 'styles.css'), siteCss(LOOKS[0]));
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0] === '/styles.css' ? 'styles.css' : 'index.html';
    try {
      const body = readFileSync(path.join(dir, name));
      res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const port = (server.address() as { port: number }).port;
  const site: DemoSite = {
    url: `http://localhost:${port}/`,
    dir,
    runs: 0,
    read: (file) => readFileSync(path.join(dir, file), 'utf8'),
    write: (file, content) => writeFileSync(path.join(dir, file), content),
  };
  const entry = { site, server, timer: setTimeout(() => close(sessionId), QUIET_MS) };
  entry.timer.unref?.();
  sites.set(sessionId, entry);
  return { site, fresh: true };
}
