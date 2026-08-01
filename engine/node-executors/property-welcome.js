const send = require('../../whatsapp/send');
const { buttonMessage, textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  if (!propertyId) {
    // No property selected — send fallback and skip
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, config.fallback_text || 'Please select a property first.'),
    });
    return { success: false, type: 'NO_PROPERTY_SELECTED' };
  }

  // Fetch the property from DB to get its welcome message
  const property = await db.getPropertyById(propertyId);
  if (!property) {
    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(to, 'Sorry, that property is no longer available.'),
    });
    return { success: false, type: 'PROPERTY_NOT_FOUND' };
  }

  // Build the message: property welcome_message + optional suffix from config
  let messageText = property.welcome_message || '';
  if (config.suffix_text) {
    messageText += '\n\n' + config.suffix_text;
  }

  // Resolve {{placeholders}} using context
  messageText = messageText
    .replace(/\{\{property_name\}\}/g, property.property_name)
    .replace(/\{\{price\}\}/g, property.price_min ? `₹${(property.price_min / 100000).toFixed(1)}L` : '')
    .replace(/\{\{possession\}\}/g, property.possession_date ? new Date(property.possession_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : 'Ready to Move');

  // Buttons come from the flow node config (managed in Flow Builder)
  // NOT from the property table — so all properties show same actions
  const buttons = (config.buttons || []).map(b => ({
    id: String(b.id),
    title: String(b.title).slice(0, 20),
  }));

  let payload;
  if (buttons.length > 0 && buttons.length <= 3) {
    payload = buttonMessage(to, messageText, buttons, config.header);
  } else {
    payload = textMessage(to, messageText);
  }

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return {
    success: true,
    type: 'PROPERTY_WELCOME_SENT',
    property_id: propertyId,
    property_name: property.property_name,
  };
}

module.exports = {
  execute,
  defaultConfig: {
    text: 'Welcome to our project!',
    buttons: [
      { id: 'GET_BROCHURE', title: 'Get Brochure' },
      { id: 'BOOK_VISIT', title: 'Book Site Visit' },
      { id: 'CALL_ME', title: 'Call Me' }
    ]
  }
};