import type { NextConfig } from "next";

const API = process.env.LAB_API_URL || "http://localhost:10201";

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
};

export default nextConfig;
