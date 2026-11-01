/** @type {import('next').NextConfig} */
export default {
  // DEMO_MODE runs the test deployment: demo data and simulated payments, with no real money.
  // Remove this line, and set the settings in .env.example, before going live.
  env: { DEMO_MODE: '1' },
  serverExternalPackages: ['pg'],
  // The server reads the demo photos from disk, so they must ship with the server routes.
  outputFileTracingIncludes: { '/api/**': ['./demo-photos/**'] },
  async rewrites() {
    return [{ source: '/photos/:file', destination: '/api/photos/:file' }];
  },
};
