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
  const { text, header, footer, list_title, button_text } = config;

  if (!text) {
    throw new Error('show_list node missing "text" in config');
  }

  let items = [];

  const answers = await db.getLeadAnswers(lead.lead_id);
  const answersMap = {};
  for (const a of answers) {
    answersMap[a.field_name] = a.field_value;
  }

  const mode = config.filter_mode || 'all';
  const matchDimensions = config.match_dimensions || [];
  const hasOldConditions = config.filter_conditions && config.filter_conditions.length > 0;

  if (mode === 'filtered') {
    if (matchDimensions.length > 0) {
      const filtered = await propertyService.getSmartFilteredProperties(
        lead.client_id, answersMap, matchDimensions
      );
      items = filtered.map(p => ({
        id: `PROPERTY_${p.property_id}`,
        title: p.property_name.slice(0, 24),
        description: `₹${(p.price_min / 100000).toFixed(1)}L - ₹${(p.price_max / 100000).toFixed(1)}L | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`
      }));
    } else if (hasOldConditions) {
      const filtered = await propertyService.getFilteredProperties(
        lead.client_id, config.filter_conditions, answersMap
      );
      items = filtered.map(p => ({
        id: `PROPERTY_${p.property_id}`,
        title: p.property_name.slice(0, 24),
        description: `₹${(p.price_min / 100000).toFixed(1)}L - ₹${(p.price_max / 100000).toFixed(1)}L | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`
      }));
    } else {
      const allProps = await db.getPropertiesByClient(lead.client_id);
      items = allProps.map(p => ({
        id: `PROPERTY_${p.property_id}`,
        title: p.property_name.slice(0, 24),
        description: `₹${(p.price_min / 100000).toFixed(1)}L - ₹${(p.price_max / 100000).toFixed(1)}L | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`
      }));
    }
  } else {
    const allProps = await db.getPropertiesByClient(lead.client_id);
    items = allProps.map(p => ({
      id: `PROPERTY_${p.property_id}`,
      title: p.property_name.slice(0, 24),
      description: `₹${(p.price_min / 100000).toFixed(1)}L - ₹${(p.price_max / 100000).toFixed(1)}L | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`
    }));
  }

  if (items.length === 0) {
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, 'Sorry, no properties match your criteria right now. Tap "Request Callback" and our agent will help you find the perfect home.'),
    });
    return { success: true, type: 'LIST_EMPTY' };
  }

  const sections = [{
    title: list_title || 'Select',
    rows: items.map(item => ({
      id: String(item.id),
      title: String(item.title).slice(0, 24),
      description: item.description ? String(item.description).slice(0, 72) : undefined,
    })),
  }];

  const payload = listMessage(to, text, button_text || 'View Options', sections, header, footer);

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return { success: true, type: 'LIST_SENT', item_count: items.length };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Here are matching properties:',
    source_table: 'properties',
    filter_mode: 'all',
    match_dimensions: []
  }
};