const db = require('../db/queries');

// Resolve {{variables}} inside node config strings
async function resolveConfig(config, leadId) {
  const lead = await db.getLeadById(leadId);
  const answers = await db.getLeadAnswers(leadId);
  const answersMap = {};
  for (const a of answers) {
    answersMap[a.field_name] = a.field_value;
  }

  const context = {
    // Lead info
    lead_name: lead.name || 'there',
    whatsapp_number: lead.whatsapp_number,

    // Answers
    requirement_type: answersMap.requirement_type || '',
    configuration: answersMap.configuration || '',
    budget_range: answersMap.budget_range || '',
    timeline: answersMap.timeline || '',

    // Context data
    selected_property_id: lead.context_data?.selected_property_id || null,
    selected_property_name: lead.context_data?.selected_property_name || '',
    selected_agent_id: lead.assigned_agent_id || null,
  };

  // If property selected, fetch its name
  if (context.selected_property_id && !context.selected_property_name) {
    const prop = await db.getPropertyById(context.selected_property_id);
    if (prop) {
      context.selected_property_name = prop.property_name;
    }
  }

  // If agent assigned, fetch agent details
  if (context.selected_agent_id) {
    const agent = await db.getAgentById(context.selected_agent_id);
    if (agent) {
      context.agent_name = agent.name;
      context.agent_phone = agent.phone || '';
    }
  }

  // Deep clone and resolve
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

module.exports = {
  resolveConfig,
};