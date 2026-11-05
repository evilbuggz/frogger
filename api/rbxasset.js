const API_URL = 'https://apis.roblox.com/asset-delivery-api/v1/assetId/';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendError(res, 405, 'Use GET for this request.');
  const assetId = String(req.query?.id || '').trim();
  if (!/^\d{1,20}$/.test(assetId)) return sendError(res, 400, 'A numeric Roblox mesh or texture asset ID is required.');
  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) return sendError(res, 503, 'Roblox asset access is not configured.');

  try {
    let response = await fetch(`${API_URL}${assetId}`, {
      headers: { 'x-api-key': apiKey, Accept: '*/*' },
      redirect: 'manual'
    });
    if (response.status === 401 || response.status === 403) return sendError(res, 403, 'Roblox denied access to this mesh or texture. Check the API key permissions and whether its owner can access this asset.');
    if (response.status === 404 || response.status === 400) return sendError(res, 404, 'Roblox could not find an accessible mesh or texture with that ID.');

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!isRobloxDeliveryUrl(location)) return sendError(res, 502, 'Roblox returned an unexpected asset location.');
      response = await fetch(location);
    }
    if (!response.ok) return sendError(res, 502, `Roblox returned status ${response.status} for this asset.`);

    if ((response.headers.get('content-type') || '').includes('json')) {
      const payload = await response.json();
      const location = payload?.locations?.[0]?.location || payload?.location;
      if (!isRobloxDeliveryUrl(location)) return sendError(res, 502, 'Roblox did not return an asset download location.');
      response = await fetch(location);
      if (!response.ok) return sendError(res, 502, `Roblox's asset server returned status ${response.status}.`);
    }

    if (!response.body) return sendError(res, 502, 'Roblox returned an empty asset.');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < 12) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      length += chunk.length;
    }
    const prefix = Buffer.concat(chunks, length);
    const contentType = identifyContentType(prefix, response.headers.get('content-type'));
    if (!contentType) {
      await reader.cancel();
      return sendError(res, 415, 'Roblox returned an unsupported asset format for this mesh or texture reference.');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    for (const chunk of chunks) if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error('Roblox asset request failed:', error);
    if (!res.headersSent) return sendError(res, 502, 'Could not retrieve a referenced Roblox mesh or texture.');
    res.destroy(error);
  }
};

function sendError(res, status, message) {
  return res.status(status).json({ error: message, fehler: message });
}

function identifyContentType(prefix, advertisedType = '') {
  const type = String(advertisedType).split(';', 1)[0].trim().toLowerCase();
  if (prefix.subarray(0, 8).toString('ascii') === 'version ') return 'model/x-file-mesh-data';
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (prefix.length >= 6 && /^GIF8[79]a$/.test(prefix.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(type)) return type;
  return null;
}

function isRobloxDeliveryUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'roblox.com' || host.endsWith('.roblox.com') || host.endsWith('.rbxcdn.com'));
  } catch { return false; }
}
