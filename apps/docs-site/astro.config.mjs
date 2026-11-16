// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://fzn0x.github.io",
  base: "/nether",
  integrations: [
    starlight({
      title: "Nether",
      description:
        "Local-first Markdown notes with databases and collaboration, on a server you control.",
      logo: { src: "./src/assets/mark.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/fzn0x/nether" }],
      editLink: { baseUrl: "https://github.com/fzn0x/nether/edit/main/apps/docs-site/" },
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        { label: "Start here", items: ["introduction", "install", "roadmap"] },
        {
          label: "Notes",
          items: [
            "vaults",
            "folders",
            "writing",
            "properties",
            "databases",
            "formulas",
            "queries",
            "templates",
            "links",
            "graph",
            "canvas",
            "pdfs",
            "search",
            "export",
            "import",
            "keyboard",
            "appearance",
            "markdown",
          ],
        },
        { label: "Servers", items: ["servers", "self-hosting", "api"] },
        { label: "Plugins", items: ["plugins"] },
      ],
    }),
  ],
});
