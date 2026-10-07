import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // site/ is its own app, not a member of the repo's pnpm workspace; root turbopack here so it never walks up
  turbopack: { root: import.meta.dirname },
  async redirects() {
    return [
      // the remote-access guides lived at the site root's #remote-access before the docs existed
      { source: "/docs/remote", destination: "/docs/remote-access", permanent: false },
    ];
  },
};

export default createMDX()(config);
