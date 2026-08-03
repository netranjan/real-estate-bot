const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const scoringService = require('../../services/scoring-service');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  // Calculate and update score
  const score = await scoringService.calculateLeadScore(lead.lead_id);

  const { notify_lead, notify_message } = config;

  if (notify_lead) {
    const to = lead.whatsapp_number;
    const message = notify_message
      ? notify_message.replace(/\{\{score\}\}/g, score)
      : `Your profile score: ${score}/100. Our team will reach out shortly.`;

    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, message),
    });
  }

  return { success: true, type: 'SCORE_CALCULATED', score };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Calculating your score…'
  }
};