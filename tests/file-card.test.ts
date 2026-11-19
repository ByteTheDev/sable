import { describe, expect, it } from 'vitest';
import { folderOf } from '@/features/timeline/FileCard';

describe('folderOf', () => {
  it('names where a shared file lies, relative to the session folder or home', () => {
    expect(folderOf('C:\\work\\relay-api\\reports\\audit.pdf', 'C:\\work\\relay-api', 'C:\\Users\\me')).toBe('reports');
    expect(folderOf('/work/relay-api/out/a/b.csv', '/work/relay-api', '/home/me')).toBe('out/a');
    expect(folderOf('/home/me/Downloads/b.csv', '/work/relay-api', '/home/me')).toBe('~/Downloads');
    expect(folderOf('/srv/data/b.csv', '/work/relay-api', '/home/me')).toBe('/srv/data');
  });

  it('says the folder itself by name when the file lies right in it', () => {
    expect(folderOf('/work/relay-api/audit.pdf', '/work/relay-api', '/home/me')).toBe('relay-api');
    expect(folderOf('C:\\work\\relay-api\\audit.pdf', 'C:\\work\\relay-api\\', '')).toBe('relay-api');
  });

  it('has nothing to say for a bare name', () => {
    expect(folderOf('audit.pdf', '/work', '/home/me')).toBe('');
  });
});
