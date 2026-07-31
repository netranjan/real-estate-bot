const send = require('../../whatsapp/send');
const { buttonMessage, listMessage, textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, buttons, header, footer } = config;

  if (!text) {
    throw new Error('send_message node missing "text" in config');
  }

  let payload;

  if (buttons && Array.isArray(buttons) && buttons.length > 0) {
    // WhatsApp allows max 3 buttons
    if (buttons.length <= 3) {
      payload = buttonMessage(to, text, buttons, header);
    } else {
      // Convert to list message for > 3 options
      const sections = [{
        title: header || 'Options',
        rows: buttons.map((b) => ({
          id: String(b.id),
          title: String(b.title).slice(0, 24),
        })),
      }];
      payload = listMessage(to, text, 'Select Option', sections, header, footer);
    }
  } else {
    payload = textMessage(to, text);
  }

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return { success: true, type: 'MESSAGE_SENT' };
}

module.exports = { execute };