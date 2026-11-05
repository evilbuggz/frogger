const API_URL = 'https://apis.roblox.com/asset-delivery-api/v1/assetId/';
const PUBLIC_ASSET_URL = 'https://assetdelivery.roblox.com/v1/asset/?id=';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendError(res, 405, 'Use GET for this request.');
  res.setHeader('X-Threadline-Asset-Route', 'raw-asset-v2');
  const assetId = String(req.query?.id || '').trim();
  if (!/^\d{1,20}$/.test(assetId)) return sendError(res, 400, 'A numeric Roblox mesh or texture asset ID is required.');
  // Keep texture delivery credentials separate from the model download route.
  // MiniBlend uses this endpoint for both mesh and image references.
  const apiKey = process.env.ROBLOX_TEXTURE_API_KEY || process.env.ROBLOX_API_KEY;
  if (!apiKey) return sendError(res, 503, 'Texture delivery is not configured. Add ROBLOX_TEXTURE_API_KEY in Vercel project settings.');

  try {
    let currentId = assetId;
    for (let depth = 0; depth < 3; depth++) {
      const response = await getAssetResponse(currentId, apiKey);
      if (!response.body) return sendError(res, 502, `Roblox returned an empty asset for ${currentId}.`);
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
      const advertisedType = response.headers.get('content-type') || '';
      const contentType = identifyContentType(prefix, advertisedType);
      if (contentType) {
        return streamAsset(res, reader, chunks, contentType);
      }

      if (isXmlAsset(prefix, advertisedType)) {
        const xmlChunks = [...chunks];
        while (length <= 2 * 1024 * 1024) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          xmlChunks.push(chunk);
          length += chunk.length;
        }
        if (length > 2 * 1024 * 1024) return streamAsset(res, reader, xmlChunks, advertisedType || 'application/xml');
        const imageId = extractTextureImageId(Buffer.concat(xmlChunks, length).toString('utf8'));
        if (imageId && imageId !== currentId) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          currentId = imageId;
          continue;
        }
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        res.statusCode = 200;
        res.setHeader('Content-Type', safeContentType(advertisedType) || 'application/xml');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.end(Buffer.concat(xmlChunks, length));
      }

      // Preserve Roblox's bytes even when the format is unknown. The browser
      // can inspect the signature and decide whether it is an image or mesh.
      return streamAsset(res, reader, chunks, safeContentType(advertisedType));
    }
    return sendError(res, 502, `Roblox's texture reference for ${assetId} contained too many nested assets.`);
  } catch (error) {
    console.error('Roblox asset request failed:', error);
    if (!res.headersSent) return sendError(res, 502, error?.message || 'Could not retrieve a referenced Roblox mesh or texture.');
    res.destroy(error);
  }
};

async function getAssetResponse(assetId, apiKey) {
  let response = await fetch(`${API_URL}${assetId}`, {
    headers: { 'x-api-key': apiKey, Accept: '*/*' },
    redirect: 'manual'
  });
  const cloudStatus = response.status;
  if ([400, 401, 403, 404, 410, 415].includes(response.status)) return getPublicAssetResponse(assetId, cloudStatus);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!isRobloxDeliveryUrl(location)) throw new Error('Roblox returned an unexpected asset location.');
    response = await fetch(location);
  }
  if (!response.ok) return getPublicAssetResponse(assetId, cloudStatus);
  if ((response.headers.get('content-type') || '').includes('json')) {
    const payload = await response.json();
    const location = payload?.locations?.[0]?.location || payload?.location;
    if (!isRobloxDeliveryUrl(location)) return getPublicAssetResponse(assetId, cloudStatus);
    response = await fetch(location);
    if (!response.ok) return getPublicAssetResponse(assetId, cloudStatus);
  }
  return response;
}

async function getPublicAssetResponse(assetId, cloudStatus) {
  let response = await fetch(`${PUBLIC_ASSET_URL}${encodeURIComponent(assetId)}`, {
    headers: { Accept: '*/*' },
    redirect: 'manual'
  });
  const publicStatus = response.status;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!isRobloxDeliveryUrl(location)) throw new Error('Roblox returned an unexpected public asset location.');
    response = await fetch(location);
  }
  if (!response.ok) throw new Error(`Roblox could not deliver asset ${assetId}. Open Cloud returned ${cloudStatus}; public Asset Delivery returned ${publicStatus}.`);
  if ((response.headers.get('content-type') || '').includes('json')) {
    const payload = await response.json();
    const location = payload?.locations?.[0]?.location || payload?.location;
    if (!isRobloxDeliveryUrl(location)) throw new Error('Roblox did not return an asset download location.');
    response = await fetch(location);
    if (!response.ok) throw new Error(`Roblox's public asset server returned status ${response.status} for asset ${assetId}.`);
  }
  return response;
}

function isXmlAsset(prefix, advertisedType) {
  const type = String(advertisedType).toLowerCase();
  const sample = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return type.includes('xml') || sample.startsWith('<?xml') || /^<roblox(?:\s|>)/i.test(sample);
}

function extractTextureImageId(xml) {
  const contentBlocks = xml.match(/<Content\b[^>]*>[\s\S]*?<\/Content>/gi) || [];
  for (const block of contentBlocks) {
    if (!/\bname\s*=\s*["']Texture["']/i.test(block)) continue;
    const value = (block.match(/<url\b[^>]*>([\s\S]*?)<\/url>/i)?.[1] || block)
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#x2F;/gi, '/');
    const id = value.match(/rbxassetid:\/\/(\d+)|[?&]id=(\d+)/i);
    const imageId = id?.[1] || id?.[2];
    if (imageId) return imageId;
  }
  return null;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message, fehler: message });
}

async function streamAsset(res, reader, chunks, contentType) {
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  try {
    for (const chunk of chunks) if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
    }
    return res.end();
  } finally {
    reader.releaseLock();
  }
}

function safeContentType(value) {
  const type = String(value || '').split(';', 1)[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
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
