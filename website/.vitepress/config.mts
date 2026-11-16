import { defineConfig } from "vitepress";

export default defineConfig({
  title: "opencode-muse",
  description:
    "Use a Muse Code subscription from OpenCode, with auth and inference staying inside the official Muse CLI.",
  base: "/opencode-muse/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Compatibility", link: "/guide/compatibility" },
      { text: "Releases", link: "https://github.com/pgquiles/opencode-muse/releases" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Models and effort", link: "/guide/models" },
            { text: "Compatibility", link: "/guide/compatibility" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/pgquiles/opencode-muse" },
      { icon: "npm", link: "https://www.npmjs.com/package/opencode-muse" },
    ],
    editLink: {
      pattern: "https://github.com/pgquiles/opencode-muse/edit/main/website/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "MIT licensed. Auth and inference stay inside the official Muse Code CLI.",
      copyright: "opencode-muse contributors",
    },
  },
});
