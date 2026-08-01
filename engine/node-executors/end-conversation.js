// engine/node-executors/end-conversation.js
const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const text = config.text || 'Thank you for contacting us! We’ll get back to you if needed. 🙏';

  const payload = textMessage(to, text);

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  // Optionally update lead pipeline stage (optional)
  // await db.updateLeadPipeline(lead.lead_id, 'Conversation Ended');

  return {
    success: true,
    type: 'CONVERSATION_ENDED',
    wait_for_input: false,
    done: true
  };
}

module.exports = { execute };