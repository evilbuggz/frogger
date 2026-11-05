const API_URL = 'https://apis.roblox.com/asset-delivery-api/v1/assetId/';

function getAssetId(input) {
  const value = String(input || '').trim();
  if (/^\d{1,20}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an asset ID or a valid Roblox URL.'); }
  const host = url.hostname.toLowerCase();
  if (!(host === 'roblox.com' || host.endsWith('.roblox.com'))) {
    throw new Error('Use a URL from roblox.com.');
  }
  const fromPath = url.pathname.match(/(?:catalog|library|store\/asset|asset)\/(\d{1,20})(?:\/|$)/i);
  const fromQuery = url.searchParams.get('id')?.match(/^\d{1,20}$/);
  const id = fromPath?.[1] || fromQuery?.[0];
  if (!id) throw new Error('Could not find an asset ID in that URL.');
  return id;
}

function deliveryLocation(payload) {
  if (payload?.locations?.[0]?.location) return payload.locations[0].location;
  if (payload?.location) return payload.location;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST for this request.' });
  let assetId;
  try { assetId = getAssetId(req.body?.asset); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Downloader is not configured yet. Add ROBLOX_API_KEY in Vercel project settings.' });

  try {
    const response = await fetch(`${API_URL}${assetId}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      redirect: 'manual'
    });
    if (response.status === 401 || response.status === 403) {
      return res.status(403).json({ error: 'Roblox denied access. Check that your API key has the legacy-asset:manage permission and access to this asset.' });
    }
    if (response.status === 404 || response.status === 400) {
      return res.status(404).json({ error: 'Roblox could not find an accessible asset with that ID.' });
    }
    let assetResponse = response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!isRobloxDeliveryUrl(location)) return res.status(502).json({ error: 'Roblox returned an unexpected download location.' });
      assetResponse = await fetch(location);
    }
    if (!assetResponse.ok) return res.status(502).json({ error: `Roblox's file server returned status ${assetResponse.status}.` });
    if ((assetResponse.headers.get('content-type') || '').includes('json')) {
      const payload = await assetResponse.json();
      const location = deliveryLocation(payload);
      if (!isRobloxDeliveryUrl(location)) return res.status(502).json({ error: 'Roblox did not return a valid asset download location.' });
      assetResponse = await fetch(location);
      if (!assetResponse.ok) return res.status(502).json({ error: `Roblox's file server returned status ${assetResponse.status}.` });
    }

    return await sendAsDownload(assetResponse, assetId, res);
  } catch (error) {
    console.error('Roblox asset delivery request failed:', error);
    return res.status(502).json({ error: 'Could not contact Roblox Asset Delivery. Try again shortly.' });
  }
};

async function sendAsDownload(assetResponse, assetId, res) {
  if (!assetResponse.body) return res.status(502).json({ error: 'Roblox returned an empty asset.' });

  const reader = assetResponse.body.getReader();
  const prefixChunks = [];
  let prefixLength = 0;
  while (prefixLength < 64) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    prefixChunks.push(chunk);
    prefixLength += chunk.length;
  }
  const prefix = Buffer.concat(prefixChunks, prefixLength);
  const file = identifyFile(prefix, assetResponse.headers.get('content-type'));
  if (!file) {
    await reader.cancel();
    return res.status(415).json({ error: 'Roblox did not return a valid Studio model file for this asset. The asset may be a mesh or preview that cannot be opened as an .rbxm model.' });
  }
  const filename = `${assetId}.${file.extension}`;
  res.statusCode = 200;
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // fetch() may transparently decompress the upstream response. Forwarding its
  // Content-Length can then truncate the streamed file and corrupt RBXM data.
  res.setHeader('Cache-Control', 'private, no-store');

  for (const chunk of prefixChunks) {
    if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  } finally {
    reader.releaseLock();
  }
}

function identifyFile(prefix, contentType = '') {
  const type = contentType.toLowerCase();
  const sample = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const binaryModelHeader = Buffer.from('3c726f626c6f782189ff0d0a1a0a', 'hex');
  if (prefix.subarray(0, binaryModelHeader.length).equals(binaryModelHeader)) {
    return { extension: 'rbxm', contentType: 'application/octet-stream' };
  }
  if (sample.startsWith('<?xml') || /^<roblox(?:>|\s)/.test(sample)) {
    return { extension: 'rbxmx', contentType: 'application/xml' };
  }
  if (type.includes('model/x-file-mesh-data') || /^version\s+\d/i.test(sample)) {
    return { extension: 'mesh', contentType: 'application/octet-stream' };
  }
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
