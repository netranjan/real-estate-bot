const send = require('../../whatsapp/send');
const { textMessage, documentMessage, imageMessage, videoMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  // 1. If static media_items are defined in the node config, use them
  if (config.media_items && Array.isArray(config.media_items) && config.media_items.length > 0) {
    for (const item of config.media_items) {
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
    return { success: true, type: 'STATIC_ASSETS_SENT', count: config.media_items.length };
  }

  // 2. If a property is selected, send all its assets
  if (propertyId) {
    const assets = await db.pool.query(
      'SELECT * FROM media_assets WHERE property_id = $1 ORDER BY created_at',
      [propertyId]
    );

    if (assets.rows.length > 0) {
      for (const asset of assets.rows) {
        if (!asset.asset_url) continue;

        let payload;
        switch (asset.asset_type) {
          case 'image': payload = imageMessage(to, asset.asset_url, asset.asset_name || 'Image'); break;
          case 'video': payload = videoMessage(to, asset.asset_url, asset.asset_name || 'Video'); break;
          default: payload = documentMessage(to, asset.asset_url, asset.asset_name || 'Document.pdf'); break;
        }

        await send({
          phoneNumberId: client.meta_phone_number_id,
          accessToken: client.meta_access_token,
          payload,
        });
      }
      return { success: true, type: 'PROPERTY_ASSETS_SENT', count: assets.rows.length };
    }
  }

  // 3. Fallback to legacy single document (brochure_url)
  let url = config.document_url || null;
  if (!url && config.document_url_field) {
    if (config.document_url_field === 'selected_property.brochure_url') {
      const property = await db.getPropertyById(propertyId);
      if (property) url = property.brochure_url || null;
    }
  }

  if (!url) {
    const fallback = config.fallback_text || 'Sorry, the document is not available right now.';
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, fallback),
    });
    return { success: false, type: 'NO_DOCUMENT_AVAILABLE' };
  }

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: documentMessage(to, url, config.filename || 'Document.pdf'),
  });

  return { success: true, type: 'LEGACY_DOCUMENT_SENT', url };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Here are your documents:',
    document_url_field: 'selected_property.brochure_url',
    filename: 'Brochure.pdf'
  }
};