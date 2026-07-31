/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Deploy builds serve from a GitHub Pages project path (e.g. /t65), and must
  // not share .next with a running dev server (corrupts it — see project notes).
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
