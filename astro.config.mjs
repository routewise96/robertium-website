import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://robertium.com',
  output: 'static',
  build: {
    format: 'directory',
  },
  compressHTML: true,
});
