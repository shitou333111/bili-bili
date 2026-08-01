import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["http://192.168.1.2:3000", "http://192.168.1.2", "192.168.1.2"],
};

export default nextConfig;
