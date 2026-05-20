/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    env: {
        NEXT_PUBLIC_WS_URL:     process.env.NEXT_PUBLIC_WS_URL     || 'ws://localhost:3001/ws',
        NEXT_PUBLIC_API_URL:    process.env.NEXT_PUBLIC_API_URL    || 'http://localhost:3001',
        NEXT_PUBLIC_PROJECT_ID: process.env.NEXT_PUBLIC_PROJECT_ID || 'default',
    },
}

module.exports = nextConfig
