/**
 * A path as a shell reads it back, as Terminal.app types a dropped file's: anything but
 * letters, digits and a few safe marks escaped with a backslash.
 */
export const shellEscape = (path) => path.replace(/[^\p{L}\p{N}_.,:@%+=/-]/gu, (c) => `\\${c}`);
