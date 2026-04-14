// @ts-check
const { themes: prismThemes } = require("prism-react-renderer");

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Toca da IA",
  tagline: "Plataforma self-hosted de agentes de IA para equipes",
  favicon: "img/favicon.svg",

  url: process.env.DOCUSAURUS_URL || "https://docs.tocadaia.com.br",
  baseUrl: "/",

  organizationName: "connect-distribuidora",
  projectName: "toca-da-ia",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "pt-BR",
    locales: ["pt-BR"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve("./sidebars.js"),
          routeBasePath: "/",
          editUrl:
            "https://github.com/connect-distribuidora/toca-da-ia/edit/main/website/",
        },
        blog: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: "Toca da IA",
        logo: {
          alt: "Toca da IA",
          src: "img/logo.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "mainSidebar",
            position: "left",
            label: "Documentação",
          },
          {
            href: "https://github.com/connect-distribuidora/toca-da-ia",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              { label: "Instalação", to: "/deploy/instalacao" },
              { label: "API Reference", to: "/api/overview" },
              { label: "FAQ", to: "/faq" },
            ],
          },
          {
            title: "Comunidade",
            items: [
              { label: "GitHub", href: "https://github.com/connect-distribuidora/toca-da-ia" },
            ],
          },
        ],
        copyright: `© ${new Date().getFullYear()} Connect Distribuidora. Construído com Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ["bash", "json", "yaml", "docker"],
      },
    }),
};

module.exports = config;
