// Function de Vercel: /api/descuentos
// Adapta la petición de Vercel al núcleo compartido (lib/descuentos-core.js).
const core = require('../lib/descuentos-core.js');

module.exports = async (req, res) => {
  let body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
  else if (Buffer.isBuffer(body)) body = body.toString('utf8');
  else if (body == null) body = '';

  const r = await core.handler({
    httpMethod: req.method,
    headers: req.headers || {},
    body,
  });

  for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
  res.statusCode = r.statusCode;
  res.end(r.body || '');
};
