# Frontier Intelligence Labs — Website

Marketing site for Frontier Intelligence Labs, an independent intelligence lab making frontier AI knowledge accessible. Implemented from the [Claude Design](https://claude.ai/design) project "Frontier Intelligence Labs Website".

![Status](https://img.shields.io/badge/status-in%20development-blue) ![Next.js](https://img.shields.io/badge/Next.js-16-black) ![React](https://img.shields.io/badge/React-19-149eca) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)

## Status at a glance

| Page | Status |
| --- | --- |
| Home (`/`) | Implemented |
| About, Vision, Objective, Team, Contact | Roadmap (designs exist in the Claude Design project) |

## Quick start

```powershell
npm install
npm run dev
```

Open http://localhost:3000. Production build: `npm run build`, then `npm run start`.

## Repository map

```
app/
  layout.tsx        Root layout — fonts (Newsreader, IBM Plex Mono via next/font), metadata
  page.tsx          Home page: hero, Fig. 01, What We Do, equations, position band
  globals.css       Design tokens (--fil-* CSS variables) and all component styles
components/
  SiteHeader.tsx    Accent bar, sticky header, nav, meta strip
  SiteFooter.tsx    Footer columns and colophon
  TunnelingFigure.tsx  Client component — animated quantum-tunneling canvas (Fig. 01)
```

## Design system

Tokens live as `--fil-*` CSS custom properties in `app/globals.css` (background, ink, muted, line, band, accent `#2E45B8`). Type: Newsreader (display serif, variable weight + optical size) and IBM Plex Mono (labels), self-hosted through `next/font/google`. The tunneling animation respects `prefers-reduced-motion` (renders a static frame).

## Verification

```powershell
npm run lint    # ESLint — passing
npm run build   # Type check + production build — passing, / prerenders statically
```

Visual check: page verified against the design in a headless browser at 1280 and 1440 widths with no console errors.

## License

No license file is currently checked in; all rights reserved by default.
