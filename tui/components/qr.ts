/**
 * QR code renderer for the TUI.
 *
 * Renders a string as an ASCII/Unicode QR code in the terminal.
 * Used to display OOBIs so a phone camera can scan them.
 */

// qrcode-terminal is a CommonJS module; use createRequire for ESM compatibility.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qrcode = require('qrcode-terminal') as {
  generate(text: string, opts: { small: boolean }, callback: (qr: string) => void): void;
};

/**
 * Render a string as a terminal QR code and return the ASCII art as a string.
 *
 * @param text  The text to encode (e.g. an OOBI string)
 * @returns     A promise resolving to the ASCII QR code string
 */
export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qr: string) => {
      resolve(qr);
    });
  });
}
