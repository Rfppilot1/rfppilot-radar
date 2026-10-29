import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Type-only imports from @radar/core are erased; nothing from the workspace packages ships to the browser.
  typedRoutes: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
