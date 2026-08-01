const send = require('../../whatsapp/send');
const { buttonMessage, listMessage, textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, options, field, header, footer, list_title, button_text } = config;

  if (!text || !field) {
    throw new Error('collect_input node missing "text" or "field" in config');
  }

  let payload;

  if (options && Array.isArray(options) && options.length > 0) {
    if (options.length <= 3) {
      // WhatsApp buttons (max 3)
      const buttons = options.map((opt) => ({
        id: String(opt.value || opt),
        title: String(opt.label || opt).slice(0, 20),
      }));
      payload = buttonMessage(to, text, buttons, header);
    } else {
      // WhatsApp list menu (> 3 options)
      const sections = [{
        title: list_title || 'Options',
        rows: options.map((opt) => ({
          id: String(opt.value || opt),
          title: String(opt.label || opt).slice(0, 24),
        })),
      }];
      payload = listMessage(to, text, button_text || 'Select', sections, header, footer);
    }
  } else {
    // Free text input (no predefined options)
    payload = textMessage(to, text);
  }

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload,
  });

  return { success: true, type: 'QUESTION_SENT', field };
}

async function saveReply(lead, config, userInput) {
  const { field, options } = config;

  if (!field) {
    throw new Error('collect_input node missing "field" in config');
  }

  // Normalize user input (trim, lower-case)
  const input = String(userInput).trim();

  // If no options defined → accept anything
  if (!options || !Array.isArray(options) || options.length === 0) {
    await db.saveLeadAnswer(lead.lead_id, field, input, lead.current_node_id);
    return { valid: true, field, value: input };
  }

  // Try exact match (case‑insensitive, trimmed) against option value
  const matchedOption = options.find(opt => {
    const val = String(opt.value || opt).trim();
    return val.toLowerCase() === input.toLowerCase();
  });

  // If still no match, try matching against the label (display name)
  if (!matchedOption) {
    const labelMatch = options.find(opt => {
      const label = String(opt.label || opt.value || opt).trim();
      return label.toLowerCase() === input.toLowerCase();
    });
    if (labelMatch) {
      // Save the VALUE of the matched label (important for filtering)
      const valueToSave = String(labelMatch.value || labelMatch.label || labelMatch).trim();
      await db.saveLeadAnswer(lead.lead_id, field, valueToSave, lead.current_node_id);
      return { valid: true, field, value: valueToSave };
    }
  }

  // If match found by value
  if (matchedOption) {
    const valueToSave = String(matchedOption.value || matchedOption).trim();
    await db.saveLeadAnswer(lead.lead_id, field, valueToSave, lead.current_node_id);
    return { valid: true, field, value: valueToSave };
  }

  // No match → still reject (but we'll give a clearer hint)
  const validExamples = options
    .slice(0, 3)
    .map(o => String(o.label || o.value || o))
    .join(', ');
  return {
    valid: false,
    error: `Please choose from: ${validExamples}`
  };
}

module.exports = {
  execute,
  saveReply,
  defaultConfig: {
    text: 'Please choose an option:',
    options: [
      { label: 'Option 1', value: 'Option 1' },
      { label: 'Option 2', value: 'Option 2' }
    ],
    field: 'answer'
  }
};