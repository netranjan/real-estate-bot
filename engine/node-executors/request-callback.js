const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const callbackService = require('../../services/callback-service');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, sla_minutes, assign_to, confirmation_message } = config;

  // Find agent to assign
  let agentId = lead.assigned_agent_id || null;
  let agentName = 'our sales representative';

  if (!agentId && assign_to === 'available_agent') {
    const agents = await db.getActiveAgents(lead.client_id);
    if (agents.length > 0) {
      // Simple round-robin: pick first available (you can enhance later)
      agentId = agents[0].agent_id;
      agentName = agents[0].name;
    }
  } else if (agentId) {
    const agent = await db.getAgentById(agentId);
    if (agent) {
      agentName = agent.name;
    }
  }

  // Create callback request
  const callback = await callbackService.requestCallback({
    leadId: lead.lead_id,
    assignedAgentId: agentId,
    slaMinutes: sla_minutes || 15,
  });

  // Assign agent to lead if not already
  if (agentId && !lead.assigned_agent_id) {
    await db.assignAgentToLead(lead.lead_id, agentId);
  }

  // Update pipeline
  await db.updateLeadPipeline(lead.lead_id, 'Callback Requested');

  // Send confirmation
  const message = confirmation_message
    ? confirmation_message.replace(/\{\{agent_name\}\}/g, agentName)
    : `Got it! Our sales representative ${agentName} will call you on this WhatsApp number within ${sla_minutes || 15} minutes. 📞\n\nThank you for reaching out!`;

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, message),
  });

  return { success: true, type: 'CALLBACK_REQUESTED', callback_id: callback.callback_request_id };
}

module.exports = { execute };