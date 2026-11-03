/**
 * Keeps a block where the reader is looking: as wide as the editor shows, and
 * there however far a long line has the code scrolled sideways.
 *
 * A block widget lives in `.cm-content`, which is as wide as the longest line,
 * so every ancestor it has is too wide to size it by; what is visible is the
 * scroller beside the gutter, and that has to be measured. Zero wide until it
 * is — a guess must not reach the code's layout, and the observer delivers
 * before the first paint.
 */
export function inView(element: HTMLElement): void {
  element.style.width = '0';
  element.style.position = 'sticky';
  const placed = new ResizeObserver(() => {
    const scroller = element.closest('.cm-scroller');
    if (!scroller) return;
    placed.disconnect();
    const gutters = scroller.querySelector('.cm-gutters');
    const sizes = new ResizeObserver(() => {
      if (!element.isConnected) return sizes.disconnect();
      const gutter = gutters?.clientWidth ?? 0;
      element.style.left = `${gutter}px`;
      element.style.width = `${scroller.clientWidth - gutter}px`;
    });
    sizes.observe(scroller);
    if (gutters) sizes.observe(gutters);
  });
  placed.observe(element);
}
