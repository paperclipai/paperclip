export default (ctx) => `<!DOCTYPE html>
<html lang="en" class="dark" style="color-scheme: dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#18181b" />
    <title>${ctx.title} directions</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      html {
        height: auto;
        min-height: 100%;
        overflow-y: auto;
      }
      body {
        height: auto;
        min-height: 100%;
        overflow: visible;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/${ctx.slug}-directions/main.tsx"></script>
  </body>
</html>
`;
