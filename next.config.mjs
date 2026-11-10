/** @type {import('next').NextConfig} */
export default {
  // Demo mode (invented contestants, simulated payments) is the DEMO_MODE=1 setting in .env, for
  // trying the site out. The live site runs without it. See "Going live" in the README.
  serverExternalPackages: ['pg'],
  // The server reads the demo photos from disk, so they must ship with the server routes.
  outputFileTracingIncludes: { '/api/**': ['./demo-photos/**'] },
  async rewrites() {
    return [{ source: '/photos/:file', destination: '/api/photos/:file' }];
  },
};
