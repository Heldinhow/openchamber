/**
 * How many reference entries the session header can show before it has to
 * collapse the rest into a `+N` control. When nothing is hidden every entry
 * fits; otherwise the last visible entry must leave room for the control.
 */
export function visibleReferenceCount(
  widths: readonly number[],
  available: number,
  gap: number,
  overflowWidth: number,
): number {
  if (widths.length === 0) {
    return 0;
  }

  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= available) {
    return widths.length;
  }

  let visible = 0;
  let used = 0;
  for (const width of widths) {
    const nextUsed = used + (visible > 0 ? gap : 0) + width;
    if (nextUsed + gap + overflowWidth > available) {
      break;
    }
    used = nextUsed;
    visible += 1;
  }
  return visible;
}
