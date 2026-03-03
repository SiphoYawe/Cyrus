import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement scrollIntoView — mock it globally
window.HTMLElement.prototype.scrollIntoView = function () {};

// jsdom doesn't implement ResizeObserver — required by Radix Slider and Select
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// jsdom doesn't implement PointerEvent properly — shim for Radix UI
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

