import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://robertium.com',
  output: 'static',
  build: {
    format: 'directory',
  },
  compressHTML: true,
  integrations: [sitemap()],
});
