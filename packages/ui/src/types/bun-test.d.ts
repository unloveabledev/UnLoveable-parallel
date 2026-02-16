declare module 'bun:test' {
  // Minimal typings for Bun's test helpers so UI type-check can include a few pure unit tests.
  export const describe: (name: string, fn: () => void) => void;
  export const it: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: (value: unknown) => {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
  };
}
