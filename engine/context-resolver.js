const db = require('../db/queries');

async function resolveConfig(config, leadId) {
  const lead = await db.getLeadById(leadId);
  const answers = await db.getLeadAnswers(leadId);
  const answersMap = {};
  for (const a of answers) {
    answersMap[a.field_name] = a.field_value;
  }

  const context = {
    lead_name: lead.name || 'there',
    whatsapp_number: lead.whatsapp_number,
    requirement_type: answersMap.requirement_type || '',
    configuration: answersMap.configuration || '',
    budget_range: answersMap.budget_range || '',
    timeline: answersMap.timeline || '',
    selected_property_id: lead.context_data?.selected_property_id || null,
    selected_property_name: lead.context_data?.selected_property_name || '',
    selected_agent_id: lead.assigned_agent_id || null,
  };

  // Resolve selected property fields
  if (context.selected_property_id) {
    const prop = await db.getPropertyById(context.selected_property_id);
    if (prop) {
      context.selected_property_name = prop.property_name;
      context.property_name = prop.property_name;
      context.property_location = prop.location || '';
      context.property_price = prop.price_min ? `₹${(prop.price_min / 100000).toFixed(1)}L` : '';
      context.property_price_max = prop.price_max ? `₹${(prop.price_max / 100000).toFixed(1)}L` : '';
      context.property_possession = prop.possession_date
        ? new Date(prop.possession_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
        : 'Ready to Move';
      context.property_brochure_url = prop.brochure_url || '';
      context.property_configuration = Array.isArray(prop.configuration_types)
        ? prop.configuration_types.join(', ')
        : (prop.configuration_types || '');
    }
  }

  // Resolve agent fields
  if (context.selected_agent_id) {
    const agent = await db.getAgentById(context.selected_agent_id);
    if (agent) {
      context.agent_name = agent.name;
      context.agent_phone = agent.phone || '';
    }
  }

  const resolved = JSON.parse(JSON.stringify(config));

  function resolveString(str) {
    return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return context[key] !== undefined ? String(context[key]) : match;
    });
  }

  function traverse(obj) {
    if (typeof obj === 'string') {
      return resolveString(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(traverse);
    }
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = traverse(v);
      }
      return result;
    }
    return obj;
  }

  return traverse(resolved);
}

module.exports = { resolveConfig };