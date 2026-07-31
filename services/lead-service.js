const db = require('../db/queries');

async function findOrCreateLead({ whatsappNumber, name, clientId }) {
  let lead = await db.findLeadByWhatsApp(whatsappNumber, clientId);

  if (!lead) {
    // Get the client's active flow
    const flow = await db.getActiveFlowForClient(clientId);
    if (!flow) {
      throw new Error(`No active flow found for client ${clientId}`);
    }

    lead = await db.createLead({
      clientId,
      whatsappNumber,
      name: name || null,
      currentFlowId: flow.flow_id,
      currentNodeId: flow.start_node_id,
    });

    console.log('➕ New lead created:', lead.lead_id, lead.whatsapp_number);
  } else if (name && lead.name !== name) {
    await db.updateLeadName(lead.lead_id, name);
    lead.name = name;
    console.log('✏️ Lead name updated:', lead.lead_id);
  }

  // Reload fresh state
  return db.getLeadById(lead.lead_id);
}

async function getLeadContext(leadId) {
  const lead = await db.getLeadById(leadId);
  const answers = await db.getLeadAnswers(leadId);
  const answersMap = {};
  for (const a of answers) {
    answersMap[a.field_name] = a.field_value;
  }
  return {
    lead,
    answers: answersMap,
    contextData: lead.context_data || {},
  };
}

async function saveToContext(leadId, key, value) {
  const lead = await db.getLeadById(leadId);
  const context = lead.context_data || {};
  context[key] = value;
  await db.updateLeadContext(leadId, context);
  return context;
}

async function transitionLeadNode(leadId, nextNodeId) {
  await db.updateLeadNode(leadId, nextNodeId);
  return db.getLeadById(leadId);
}

async function updatePipeline(leadId, stage) {
  await db.updateLeadPipeline(leadId, stage);
  return db.getLeadById(leadId);
}

async function assignAgent(leadId, agentId) {
  await db.assignAgentToLead(leadId, agentId);
  return db.getLeadById(leadId);
}

module.exports = {
  findOrCreateLead,
  getLeadContext,
  saveToContext,
  transitionLeadNode,
  updatePipeline,
  assignAgent,
};