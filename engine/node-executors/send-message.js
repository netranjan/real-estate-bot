const send = require('../../whatsapp/send');
const { textMessage, documentMessage, imageMessage, videoMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function sendMediaItems(client, to, items) {
  for (const item of items) {
    const url = item.url || item.document_url || '';
    const type = item.type || 'document';
    const name = item.name || item.filename || 'file';
    if (!url) continue;

    let payload;
    if (type === 'image') payload = imageMessage(to, url, name);
    else if (type === 'video') payload = videoMessage(to, url, name);
    else payload = documentMessage(to, url, name);

    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload,
    });
  }
}

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  // source: 'auto' | 'static' | 'property'
  // 'auto'    = static if configured, else property
  // 'static'  = only static media_items
  // 'property'= only from selected property (ignore static)
  const source = config.source || 'auto';

  // ── CASE 1: Explicitly static ──
  if (source === 'static') {
    if (config.media_items?.length) {
      await sendMediaItems(client, to, config.media_items);
      return { success: true, type: 'STATIC_ASSETS_SENT', count: config.media_items.length };
    }
    // fall through to sorry message if no static items
  }

  // ── CASE 2: Property-based ──
  if (propertyId && (source === 'property' || source === 'auto')) {
    // If auto + static items exist, we already sent them above (when source=static block).
    // If auto + no static items, we fetch from property.
    // If property source, we ALWAYS fetch from property.

    const assetType = config.property_asset_type || 'all'; // 'all' | 'brochure' | 'image' | 'video'
    const assets = [];

    // 2a. Direct brochure_url from properties table
    const property = await db.getPropertyById(propertyId);
    if (property?.brochure_url && (assetType === 'brochure' || assetType === 'all')) {
      assets.push({
        asset_type: 'document',
        asset_url: property.brochure_url,
        asset_name: 'Brochure.pdf'
      });
    }

    // 2b. media_assets table
    let rows = [];
    if (assetType === 'all') {
      const result = await db.pool.query(
        'SELECT * FROM media_assets WHERE property_id = $1 ORDER BY created_at',
        [propertyId]
      );
      rows = result.rows;
    } else {
      const result = await db.pool.query(
        'SELECT * FROM media_assets WHERE property_id = $1 AND asset_type = $2 ORDER BY created_at',
        [propertyId, assetType]
      );
      rows = result.rows;
    }

    for (const row of rows) {
      if (!row.asset_url) continue;
      // avoid duplicate if brochure_url already came from properties table
      if (property?.brochure_url && row.asset_url === property.brochure_url && row.asset_type === 'document') continue;
      assets.push(row);
    }

    if (assets.length > 0) {
      for (const asset of assets) {
        const type = asset.asset_type || 'document';
        const url = asset.asset_url;
        const name = asset.asset_name || asset.filename || 'File';

        let payload;
        if (type === 'image') payload = imageMessage(to, url, name);
        else if (type === 'video') payload = videoMessage(to, url, name);
        else payload = documentMessage(to, url, name);

        await send({
          phoneNumberId: client.meta_phone_number_id,
          accessToken: client.meta_access_token,
          payload,
        });
      }
      return { success: true, type: 'PROPERTY_ASSETS_SENT', count: assets.length };
    }
  }

  // ── CASE 3: Fallback ──
  const fallback = config.fallback_text || 'Sorry, the document is not available right now.';
  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, fallback),
  });
  return { success: false, type: 'NO_DOCUMENT_AVAILABLE' };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Here are your documents:',
    source: 'auto',              // 'auto' | 'static' | 'property'
    property_asset_type: 'all',  // 'all' | 'brochure' | 'image' | 'video'
    fallback_text: 'Sorry, the document is not available right now.'
  }
};