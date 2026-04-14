/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  mainSidebar: [
    {
      type: "category",
      label: "Introdução",
      collapsed: false,
      items: ["intro", "faq"],
    },
    {
      type: "category",
      label: "Instalação",
      collapsed: false,
      items: [
        "deploy/instalacao",
        "deploy/backup-restore",
        "deploy/health-monitoring",
      ],
    },
    {
      type: "category",
      label: "API Reference",
      items: [
        "api/overview",
        "api/autenticacao",
        "api/agentes",
        "api/issues",
      ],
    },
  ],
};

module.exports = sidebars;
