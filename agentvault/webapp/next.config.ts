import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['@dfinity/agent', '@dfinity/candid', '@dfinity/principal'],
  },
  webpack: (config: any) => {
    config.externals.push({
      'utf-8-validate': 'utf-8-validate',
      'buffer': 'buffer',
    });
    return config;
  },
};

export default config;
