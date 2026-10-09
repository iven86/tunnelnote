const WIDTH = 17;
const HEIGHT = 9;
const CENTER_X = Math.floor(WIDTH / 2);
const CENTER_Y = Math.floor(HEIGHT / 2);
const ART = ' .o+=*BOX@%&#/^';

export function createHostKeyRandomArt(key: Uint8Array): string {
  const digest = createDigest(key);
  const grid = Array.from({ length: HEIGHT }, () => Array<number>(WIDTH).fill(0));
  let x = CENTER_X;
  let y = CENTER_Y;

  for (const byte of digest) {
    for (let shift = 6; shift >= 0; shift -= 2) {
      const step = (byte >> shift) & 0b11;
      x = Math.max(0, Math.min(WIDTH - 1, x + ((step & 0b01) === 0 ? -1 : 1)));
      y = Math.max(0, Math.min(HEIGHT - 1, y + ((step & 0b10) === 0 ? -1 : 1)));
      grid[y]![x] = Math.min(ART.length - 1, grid[y]![x]! + 1);
    }
  }

  const endX = x;
  const endY = y;
  grid[CENTER_Y]![CENTER_X] = -1;
  grid[endY]![endX] = -2;

  const lines = grid.map((row) =>
    row.map((cell) => (cell === -1 ? 'S' : cell === -2 ? 'E' : ART[cell])).join(''),
  );
  digest.fill(0);
  return ['+-----------------+', ...lines.map((line) => `|${line}|`), '+-----------------+'].join(
    '\n',
  );
}

function createDigest(key: Uint8Array): Uint8Array {
  return createHash('sha256').update(key).digest();
}
import { createHash } from 'node:crypto';
