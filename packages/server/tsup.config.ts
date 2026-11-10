import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    shims: true,
    target: 'node18',
    platform: 'node',
    external: ['ws', 'ffmpeg-static'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    target: 'node18',
    platform: 'node',
    external: ['ws', 'ffmpeg-static'],
  },
]);
