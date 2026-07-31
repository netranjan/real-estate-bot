const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const visitService = require('../../services/visit-service');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, options_source, confirmation_message } = config;

  if (!text) {
    throw new Error('book_appointment node missing "text" in config');
  }

  // This executor on first pass just shows the options (handled by show-list executor usually)
  // But if called directly, we send the text prompt
  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, text),
  });

  return { success: true, type: 'APPOINTMENT_PROMPT_SENT' };
}

async function saveReply(lead, config, userInput) {
  // userInput format: "VISIT_123" where 123 is visit_option_id
  if (!userInput.startsWith('VISIT_')) {
    return { valid: false, error: 'Invalid visit option' };
  }

  const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
  if (isNaN(visitOptionId)) {
    return { valid: false, error: 'Invalid visit option ID' };
  }

  const propertyId = lead.context_data?.selected_property_id;
  if (!propertyId) {
    return { valid: false, error: 'No property selected' };
  }

  // Use assigned agent if any, else null (can be assigned later)
  const agentId = lead.assigned_agent_id || null;

  const visit = await visitService.bookVisit({
    leadId: lead.lead_id,
    propertyId,
    visitOptionId,
    agentId,
  });

  // Update pipeline stage
  await db.updateLeadPipeline(lead.lead_id, 'Site Visit Booked');

  return { valid: true, visit_id: visit.site_visit_id };
}

module.exports = { execute, saveReply };