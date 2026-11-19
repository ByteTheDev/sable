import { describe, expect, it } from 'vitest';
import { isLeadIn, leadTitle } from '@/features/timeline/lead-in';

describe('isLeadIn', () => {
  it('knows the one-line announcements agents write before a step', () => {
    for (const t of [
      'Let me read the error handler and the admin routes.',
      "I'll start by finding every place that writes an error body by hand.",
      'Now let me run the tests.',
      'Perfect. Let me run the type check.',
      "Now I'll make the admin guard throw `HttpError` like the middleware does.",
      'Let me check the tests:',
      'I’m going to scan the repo for error handlers.',
      "I'm checking the routes first.",
      'Checking the webhook path next.',
      'Good, now let me look at `routes.ts`.',
      'Lass mich die Tests ausführen.',
    ])
      expect(isLeadIn(t, false), t).toBe(true);
  });

  it('keeps reports, answers and questions in view', () => {
    for (const t of [
      "Found it: the admin guard answers `{ message: 'Forbidden' }`. Let me check the routes.",
      'The admin guard now answers like the rest, and the suite passes.',
      'Done. Tests and the type check pass.',
      'Let me know if you want the webhooks changed too.',
      'Should I also change the webhooks?',
      "I'm seeing two failures in the auth tests.",
      'Let me read the handler.\n\nThen the routes.',
      `Let me ${'read every file in the project '.repeat(8)}`,
      'Now the guard throws like everywhere else.',
    ])
      expect(isLeadIn(t, false), t).toBe(false);
  });

  it('holds a text being written that may still become one, and lets it go once it plainly is not', () => {
    expect(isLeadIn('', true)).toBe(true);
    expect(isLeadIn('Le', true)).toBe(true);
    expect(isLeadIn('Now', true)).toBe(true);
    expect(isLeadIn('Now let me ru', true)).toBe(true);
    expect(isLeadIn('Perfect. Let', true)).toBe(true);
    expect(isLeadIn('The admin', true)).toBe(false);
    expect(isLeadIn('Now the guard', true)).toBe(false);
    expect(isLeadIn('Let me run the tests. They', true)).toBe(false);
    // Finished, a fragment is just a fragment.
    expect(isLeadIn('Now', false)).toBe(false);
  });
});

describe('leadTitle', () => {
  it('names what the step does, in the voice of a step title', () => {
    expect(leadTitle('Now let me run the tests.')).toBe('Run the tests');
    expect(leadTitle("I'll start by finding every place that writes an error body by hand.")).toBe('Finding every place that writes an error body by hand');
    expect(leadTitle('Perfect. Let me run the type check.')).toBe('Run the type check');
    expect(leadTitle("I'm checking the routes first.")).toBe('Checking the routes first');
    expect(leadTitle('Checking the webhook path next.')).toBe('Checking the webhook path next');
    expect(leadTitle('Let me check `routes.ts`:')).toBe('Check routes.ts');
    expect(leadTitle('Lass mich die Tests ausführen.')).toBe('Die Tests ausführen');
  });
});
