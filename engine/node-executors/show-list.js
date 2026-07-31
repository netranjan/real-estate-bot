const send = require('../../whatsapp/send');
const { listMessage, textMessage } = require('../../whatsapp/payloads');
const propertyService = require('../../services/property-service');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, source_table, filter_by, header, footer, list_title, button_text } = config;

  if (!text) {
    throw new Error('show_list node missing "text" in config');
  }

  let items = [];

  if (source_table === 'properties' && filter_by) {
    // Dynamic property filtering based on lead answers
    const answers = await db.getLeadAnswers(lead.lead_id);
    const answersMap = {};
    for (const a of answers) {
      answersMap[a.field_name] = a.field_value;
    }

    const properties = await propertyService.getMatchingProperties(
      lead.client_id,
      answersMap
    );

    items = properties.map((p) => ({
      id: `PROPERTY_${p.property_id}`,
      title: p.property_name.slice(0, 24),
      description: `₹${(p.price_min / 100000).toFixed(1)}L - ₹${(p.price_max / 100000).toFixed(1)}L | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`,
    }));
  } else if (source_table === 'property_visit_options') {
    const propertyId = lead.context_data?.selected_property_id;
    if (!propertyId) {
      throw new Error('show_list for visit options requires selected_property_id in context');
    }
    const options = await propertyService.getAvailableSlots(propertyId);
    items = options.map((o) => ({
      id: `VISIT_${o.visit_option_id}`,
      title: o.option_name.slice(0, 24),
    }));
  } else {
    // Generic list from config.items
    items = config.items || [];
  }

  if (items.length === 0) {
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, 'No matching items found.'),
    });
    return { success: true, type: 'LIST_EMPTY' };
  }

  const sections = [{
    title: list_title || 'Select',
    rows: items.map((item) => ({
      id: String(item.id),
      title: String(item.title).slice(0, 24),
      description: item.description ? String(item.description).slice(0, 72) : undefined,
    })),
  }];

  const payload = listMessage(
    to,
    text,
    button_text || 'View Options',
    sections,
    header,
    footer
  );

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return { success: true, type: 'LIST_SENT', item_count: items.length };
}

module.exports = { execute };