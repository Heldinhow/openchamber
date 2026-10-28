import { describe, expect, test } from 'bun:test';

import { visibleReferenceCount } from './repoWorkspaceSessionMetaLayout';

const GAP = 6;
const OVERFLOW = 30;

describe('visibleReferenceCount', () => {
  test('keeps every entry when all fit', () => {
    expect(visibleReferenceCount([50, 50], 200, GAP, OVERFLOW)).toBe(2);
  });

  test('keeps every entry on an exact fit', () => {
    expect(visibleReferenceCount([50, 50], 106, GAP, OVERFLOW)).toBe(2);
  });

  test('keeps zero-width entries when only their gap needs room', () => {
    expect(visibleReferenceCount([0, 0], 6, GAP, OVERFLOW)).toBe(2);
  });

  test('hides every entry when none fit', () => {
    expect(visibleReferenceCount([50, 50], 30, GAP, OVERFLOW)).toBe(0);
  });

  test('hides every entry when there is no width', () => {
    expect(visibleReferenceCount([50, 50], 0, GAP, OVERFLOW)).toBe(0);
  });

  test('keeps the entries that fit and the control for one hidden entry', () => {
    expect(visibleReferenceCount([50, 50, 50], 160, GAP, OVERFLOW)).toBe(2);
  });

  test('hides many entries behind the control', () => {
    expect(visibleReferenceCount([50, 50, 50, 50, 50], 120, GAP, OVERFLOW)).toBe(1);
  });

  test('returns zero for an empty row', () => {
    expect(visibleReferenceCount([], 200, GAP, OVERFLOW)).toBe(0);
  });
});
