const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const text = config.text || 'Thank you for reaching out. We will get back to you soon.';

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, text),
  });

  // ═══════════════════════════════════════════════════════
  // FIX: Clear property-specific context so it doesn't leak
  // into the next conversation if the user messages again
  // ═══════════════════════════════════════════════════════
  const ctx = lead.context_data || {};
  delete ctx.selected_property_id;
  delete ctx.selected_property_name;
  delete ctx.selected_visit_option_id;
  await db.updateLeadContext(lead.lead_id, ctx);

  return { success: true, type: 'CONVERSATION_ENDED' };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Thank you for reaching out. We will get back to you soon.'
  }
};