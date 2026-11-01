import { handleRequest } from '../../server/runtime.js';

export const config = {
  // The Express app reads request bodies itself: webhooks need the raw bytes, uploads are multipart.
  api: { bodyParser: false, externalResolver: true, responseLimit: false },
  maxDuration: 60,
};

export default function handler(req, res) {
  return handleRequest(req, res);
}
