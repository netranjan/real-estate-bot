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

  // ═══════════════════════════════════════════════════════
  // FIX: If a property is selected, send ITS assets first.
  // Static media_items only used when NO property is selected.
  // ═══════════════════════════════════════════════════════
  if (propertyId) {
    const property = await db.getPropertyById(propertyId);
    const assets = await db.pool.query(
      'SELECT * FROM media_assets WHERE property_id = $1 ORDER BY created_at',
      [propertyId]
    );

    let items = [];
    if (property?.brochure_url) {
      items.push({ type: 'document', url: property.brochure_url, name: 'Brochure.pdf' });
    }

    for (const asset of assets.rows) {
      if (!asset.asset_url || items.find(i => i.url === asset.asset_url)) continue;
      items.push({
        type: asset.asset_type || 'document',
        url: asset.asset_url,
        name: asset.asset_name || 'File'
      });
    }

    if (items.length > 0) {
      for (const item of items) {
        let payload;
        if (item.type === 'image') payload = imageMessage(to, item.url, item.name);
        else if (item.type === 'video') payload = videoMessage(to, item.url, item.name);
        else payload = documentMessage(to, item.url, item.name);

        await send({
          phoneNumberId: client.meta_phone_number_id,
          accessToken: client.meta_access_token,
          payload,
        });
      }
      return { success: true, type: 'PROPERTY_ASSETS_SENT', count: items.length };
    }
  }

  // 2. Static fallback (only when no property selected)
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

  // 3. Legacy single document fallback
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