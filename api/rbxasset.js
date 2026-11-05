const API_URL = 'https://apis.roblox.com/asset-delivery-api/v1/assetId/';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET for this request.' });
  const assetId = String(req.query?.id || '').trim();
  if (!/^\d{1,20}$/.test(assetId)) return res.status(400).json({ error: 'A numeric Roblox mesh asset ID is required.' });
  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Roblox asset access is not configured.' });

  try {
    let response = await fetch(`${API_URL}${assetId}`, {
      headers: { 'x-api-key': apiKey, Accept: '*/*' },
      redirect: 'manual'
    });
    if (response.status === 401 || response.status === 403) return res.status(403).json({ error: 'Roblox denied access to this mesh.' });
    if (response.status === 404 || response.status === 400) return res.status(404).json({ error: 'Roblox could not find an accessible mesh with that ID.' });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!isRobloxDeliveryUrl(location)) return res.status(502).json({ error: 'Roblox returned an unexpected mesh location.' });
      response = await fetch(location);
    }
    if (!response.ok) return res.status(502).json({ error: `Roblox returned status ${response.status} for this mesh.` });

    if ((response.headers.get('content-type') || '').includes('json')) {
      const payload = await response.json();
      const location = payload?.locations?.[0]?.location || payload?.location;
      if (!isRobloxDeliveryUrl(location)) return res.status(502).json({ error: 'Roblox did not return a mesh download location.' });
      response = await fetch(location);
      if (!response.ok) return res.status(502).json({ error: `Roblox's mesh server returned status ${response.status}.` });
    }

    if (!response.body) return res.status(502).json({ error: 'Roblox returned an empty mesh.' });
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < 8) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      length += chunk.length;
    }
    const prefix = Buffer.concat(chunks, length);
    if (prefix.subarray(0, 8).toString('ascii') !== 'version ') {
      await reader.cancel();
      return res.status(415).json({ error: 'Roblox returned a non-mesh asset for this reference.' });
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'model/x-file-mesh-data');
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
    console.error('Roblox mesh request failed:', error);
    if (!res.headersSent) return res.status(502).json({ error: 'Could not retrieve the referenced Roblox mesh.' });
    res.destroy(error);
  }
};

function isRobloxDeliveryUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'roblox.com' || host.endsWith('.roblox.com') || host.endsWith('.rbxcdn.com'));
  } catch { return false; }
}
