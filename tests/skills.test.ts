/** Display names for plugin skills: the part after the colon, the full name only on a collision. */
import { describe, expect, it } from 'vitest';
import { skillLabel, skillLabeller } from '@/lib/skills';

describe('skillLabel', () => {
  it('drops a repeated plugin prefix', () => {
    const all = ['cinetic:cinetic', 'design-taste:design-taste', 'review'];
    expect(skillLabel('cinetic:cinetic', all)).toBe('cinetic');
    expect(skillLabel('design-taste:design-taste', all)).toBe('design-taste');
  });

  it('leaves plain names alone', () => {
    expect(skillLabel('review', ['review', 'a:review'])).toBe('review');
  });

  it('keeps the full name when two entries share a short name', () => {
    const all = ['a:deploy', 'b:deploy', 'c:lint'];
    expect(skillLabel('a:deploy', all)).toBe('a:deploy');
    expect(skillLabel('b:deploy', all)).toBe('b:deploy');
    expect(skillLabel('c:lint', all)).toBe('lint');
  });

  it('collides with a plain name of the same short form', () => {
    expect(skillLabel('a:review', ['review', 'a:review'])).toBe('a:review');
  });

  it('uses the last colon and ignores duplicates and trailing colons', () => {
    expect(skillLabel('org:pack:skill', ['org:pack:skill', 'org:pack:skill'])).toBe('skill');
    expect(skillLabel('odd:', ['odd:'])).toBe('odd:');
  });

  it('labels a list in one pass', () => {
    const label = skillLabeller(['x:one', 'y:one', 'z:two']);
    expect(['x:one', 'y:one', 'z:two'].map(label)).toEqual(['x:one', 'y:one', 'two']);
  });
});
