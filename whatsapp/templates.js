// Pre-approved WhatsApp Business template registry
// Key = template_code used in flow_nodes.config
// Value = { template_name, language_code }

const TEMPLATES = {
  // Godrej Properties templates (example — replace with your actual Meta-approved names)
  godrej_welcome: {
    template_name: 'godrej_welcome_v1',
    language_code: 'en',
  },
  godrej_followup: {
    template_name: 'godrej_followup_v2',
    language_code: 'en',
  },
  godrej_site_visit_reminder: {
    template_name: 'godrej_visit_reminder',
    language_code: 'en',
  },
  godrej_callback_confirmation: {
    template_name: 'godrej_callback_conf',
    language_code: 'en',
  },
};

function getTemplatePayload(to, templateCode, bodyParams = []) {
  const template = TEMPLATES[templateCode];
  if (!template) {
    throw new Error(`Template not found: ${templateCode}`);
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template.template_name,
      language: { code: template.language_code },
      components: bodyParams.length > 0
        ? [{ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: p })) }]
        : undefined,
    },
  };
}

module.exports = {
  TEMPLATES,
  getTemplatePayload,
};