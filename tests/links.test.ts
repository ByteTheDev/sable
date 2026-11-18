import { describe, expect, it } from 'vitest';
import { addressParts, findDevUrls, isLocalHost, isLocalUrl, normalizeAddress, previewTargets } from '@/lib/links';

describe('local addresses', () => {
  it('recognises this machine', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) expect(isLocalHost(h)).toBe(true);
    for (const h of ['example.com', 'localhost.example.com', '128.0.0.1', '0.0.0.0', '10.0.0.2']) expect(isLocalHost(h)).toBe(false);
  });

  it('only counts http(s) URLs', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true);
    expect(isLocalUrl('https://[::1]:8443/x')).toBe(true);
    expect(isLocalUrl('http://shop.localhost/')).toBe(true);
    expect(isLocalUrl('file:///C:/Windows/win.ini')).toBe(false);
    expect(isLocalUrl('https://example.com/')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});

describe('previewTargets', () => {
  it('finds local pages once per host and port', () => {
    const out = previewTargets([
      'Running at http://localhost:5173/ and http://localhost:5173/about. Docs: https://vitejs.dev',
      '  ➜  Network: http://0.0.0.0:3000/\n[::1] http://[::1]:8080/x, http://127.0.0.1:4000)',
      'see [the app](http://shop.localhost/cart) and http://localhost/ (no port)',
    ]);
    expect(out).toEqual([
      { url: 'http://localhost:5173/', label: 'localhost:5173' },
      { url: 'http://localhost:3000/', label: 'localhost:3000' },
      { url: 'http://[::1]:8080/x', label: 'localhost:8080/x' },
    ]);
    expect(previewTargets(['http://127.0.0.1:4000).', 'http://shop.localhost/cart'], 5)).toEqual([
      { url: 'http://127.0.0.1:4000/', label: 'localhost:4000' },
      { url: 'http://shop.localhost/cart', label: 'shop.localhost/cart' },
    ]);
  });

  it('counts localhost and 127.0.0.1 on one port as one page', () => {
    expect(previewTargets(['Open http://localhost:5176/', 'Server at http://127.0.0.1:5176/'])).toEqual([{ url: 'http://localhost:5176/', label: 'localhost:5176' }]);
  });

  it('ignores remote and portless addresses', () => {
    expect(previewTargets(['https://example.com:8080/', 'http://localhost/', undefined, ''])).toEqual([]);
  });
});

describe('normalizeAddress', () => {
  it('adds a scheme to bare hosts', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeAddress('127.0.0.1:3000/api?x=1')).toBe('http://127.0.0.1:3000/api?x=1');
    expect(normalizeAddress('example.com')).toBe('https://example.com/');
    expect(normalizeAddress('docs.example.com/guide#top')).toBe('https://docs.example.com/guide#top');
    expect(normalizeAddress('localhost')).toBe('http://localhost/');
  });

  it('keeps full web URLs', () => {
    expect(normalizeAddress('  https://example.com/a b ')).toBe('https://example.com/a%20b');
    expect(normalizeAddress('http://localhost:8080')).toBe('http://localhost:8080/');
  });

  it('searches for plain words', () => {
    expect(normalizeAddress('react hooks')).toBe('https://duckduckgo.com/?q=react%20hooks');
    expect(normalizeAddress('vite')).toBe('https://duckduckgo.com/?q=vite');
  });

  it('refuses other schemes', () => {
    expect(normalizeAddress('file:///C:/Windows/win.ini')).toBeNull();
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeAddress('data:text/html,hi')).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
  });
});

describe('findDevUrls', () => {
  it('finds dev-server URLs in coloured output', () => {
    const vite = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host to expose';
    expect(findDevUrls(vite)).toEqual(['http://localhost:5173/']);
  });

  it('de-duplicates, trims punctuation and maps 0.0.0.0 to localhost', () => {
    const text = 'Listening on http://0.0.0.0:8000. Open http://127.0.0.1:3000/app, or http://127.0.0.1:3000/app again. Docs at https://example.com:443/';
    expect(findDevUrls(text)).toEqual(['http://localhost:8000/', 'http://127.0.0.1:3000/app']);
  });

  it('ignores URLs without a port', () => {
    expect(findDevUrls('see http://localhost/ and ECONNREFUSED 127.0.0.1:5432')).toEqual([]);
  });
});

describe('addressParts', () => {
  it('shows the host and the decoded path, never a raw query', () => {
    expect(addressParts('https://www.github.com/login?return_to=%2Fsettings%2Fprofile')).toEqual({ host: 'github.com', path: '/login' });
    expect(addressParts('http://localhost:5173/')).toEqual({ host: 'localhost:5173', path: '' });
    expect(addressParts('https://example.com/caf%C3%A9/menu/')).toEqual({ host: 'example.com', path: '/café/menu' });
    expect(addressParts('https://example.com/%E0%A4%A')).toEqual({ host: 'example.com', path: '/%E0%A4%A' });
  });

  it('shows a search as the words searched', () => {
    expect(addressParts('https://duckduckgo.com/?q=vite%20config&ia=web')).toEqual({ host: 'duckduckgo.com', path: '', search: 'vite config' });
    expect(addressParts('https://www.google.com/search?q=react+19')).toEqual({ host: 'google.com', path: '', search: 'react 19' });
    expect(addressParts('https://example.com/?q=not+a+search+engine')).toEqual({ host: 'example.com', path: '' });
  });

  it('leaves anything that is not a web URL as it is', () => {
    expect(addressParts('about:blank')).toEqual({ host: 'about:blank', path: '' });
    expect(addressParts('nonsense')).toEqual({ host: 'nonsense', path: '' });
  });
});
