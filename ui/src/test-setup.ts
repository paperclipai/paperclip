import React from "react";
import { vi } from "vitest";

/**
 * Test setup for Vitest / JSDOM environment.
 * 
 * Includes:
 * 1. Mock for `window.matchMedia`, which is not implemented in JSDOM but 
 *    required by some UI components (e.g. from shadcn/ui).
 */

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
