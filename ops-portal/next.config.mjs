/** @type {import('next').NextConfig} */
const nextConfig = {
  // No `output: 'standalone'` — this app deploys via Railway Nixpacks /
  // Vercel, both of which run `next start`, which is incompatible with
  // standalone output. (Standalone is only for Docker self-hosting, which
  // this service doesn't use.)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
