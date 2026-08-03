const send = require('../../whatsapp/send');
const { textMessage, listMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;

  // Build slot rows
  let rows = [];

  // 1. Predefined slots from node config
  if (config.options && config.options.length > 0) {
    rows = config.options.map((opt, idx) => ({
      id: `VISIT_${idx}`,
      title: String(opt.label || opt.value || 'Slot').slice(0, 24),
      description: String(opt.description || '').slice(0, 72)
    }));
  }
  // 2. Property-specific slots from DB
  else if (lead.context_data?.selected_property_id) {
    const slots = await db.getVisitOptionsForProperty(lead.context_data.selected_property_id);
    rows = slots.map(s => ({
      id: `VISIT_${s.visit_option_id}`,
      title: String(s.slot_label || s.slot_time || 'Visit').slice(0, 24),
      description: String(s.slot_time || '').slice(0, 72)
    }));
  }

  // Send slots as interactive list
  if (rows.length > 0) {
    const payload = listMessage(
      to,
      config.text || 'Please pick a convenient slot:',
      'Select Slot',
      [{ title: 'Available Slots', rows }]
    );

    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload,
    });

    return { success: true, type: 'SLOT_LIST_SENT', wait_for_input: true };
  }

  // No slots available
  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, config.text || 'No visit slots are currently available.'),
  });

  return { success: true, type: 'NO_SLOTS_AVAILABLE' };
}

async function saveReply(lead, config, userInput) {
  if (!String(userInput).startsWith('VISIT_')) {
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

  const agentId = lead.assigned_agent_id || null;

  // Create the site visit record
  await db.createSiteVisit({
    leadId: lead.lead_id,
    propertyId,
    visitOptionId,
    agentId,
  });

  await db.updateLeadPipeline(lead.lead_id, 'Site Visit Booked');

  return { valid: true, visit_id: visitOptionId };
}

module.exports = {
  execute,
  saveReply,
  defaultConfig: {
    text: 'Let\'s schedule your site visit! 🏗️\n\nPlease pick a convenient slot.'
  }
};