const send = require('../../whatsapp/send');
const { documentMessage, textMessage } = require('../../whatsapp/payloads');
const propertyService = require('../../services/property-service');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { document_url, document_url_field, filename, fallback_text } = config;

  let url = document_url || null;

  // Resolve dynamic document URL from context
  if (!url && document_url_field) {
    if (document_url_field === 'selected_property.brochure_url') {
      const propertyId = lead.context_data?.selected_property_id;
      if (propertyId) {
        url = await propertyService.getBrochureUrl(propertyId);
      }
    }
  }

  if (!url) {
    const fallback = fallback_text || 'Sorry, the document is not available right now.';
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, fallback),
    });
    return { success: false, type: 'DOCUMENT_UNAVAILABLE' };
  }

  const payload = documentMessage(
    to,
    url,
    filename || 'Document.pdf'
  );

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return { success: true, type: 'DOCUMENT_SENT', url };
}

module.exports = { execute };