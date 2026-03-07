# AgentVault Website

Docusaurus-based documentation and marketing site for AgentVault.

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run start

# Build for production
npm run build

# Serve production build locally
npm run serve
```

## Structure

```
site/
├── src/
│   ├── pages/           # Landing page, changelog
│   ├── components/      # React components
│   └── css/             # Custom styles
├── static/              # Static assets
├── docusaurus.config.ts # Site configuration
├── sidebars.ts          # Documentation sidebar
└── build/               # Production build output
```

## Deployment

The site is configured for deployment to `https://agentvault.cloud`.

### Vercel (Recommended)

1. Connect GitHub repository to Vercel
2. Set root directory to `site/`
3. Deploy

### Manual Deployment

```bash
npm run build
# Upload contents of build/ to your hosting provider
```

## Environment

- Node.js 18+
- Docusaurus 3.7+

## Documentation Source

Documentation files are located in `../docs/` and symlinked via Docusaurus config.

## Broken Links

The build currently has some broken link warnings due to relative path differences between the original markdown structure and Docusaurus routing. These are set to warn mode in `docusaurus.config.ts` and should be fixed in a future update.
