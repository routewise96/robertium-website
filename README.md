# Robertium Website

Landing page for [Robertium](https://robertium.com) — open-source infrastructure for literature-based drug discovery.

## Stack

- [Astro](https://astro.build) (static output)
- Plain CSS (no framework)
- Deployed on Cloudflare Pages
- CI/CD via GitHub Actions

## Local development

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # output to dist/
npm run preview  # serve dist/ locally
```

## Project structure

```
src/
├── pages/        # routes — index.astro, hypotheses.astro
├── layouts/      # Layout.astro wraps every page
├── components/   # reusable section components
└── styles/       # global.css
public/
├── data/         # static JSON (hypotheses.json)
├── _headers
└── robots.txt
```

## Deployment

Pushes to `main` trigger automatic deployment to Cloudflare Pages via GitHub Actions:
1. `npm ci` and `npm run build` produce `dist/`
2. `wrangler pages deploy dist` ships the bundle

## Data

`/hypotheses` reads from `public/data/hypotheses.json`. The file is generated from the Robertium Postgres database by `scripts/export_hypotheses.py` in the [robertium](https://github.com/routewise96/robertium) repo.

## License

MIT
