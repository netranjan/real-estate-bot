const send = require('../../whatsapp/send');
const { textMessage } = require('../../whatsapp/payloads');
const db = require('../../db/queries');

async function execute(lead, config) {
  const client = await db.getClientById(lead.client_id);
  if (!client || !client.meta_phone_number_id || !client.meta_access_token) {
    throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
  }

  const to = lead.whatsapp_number;
  const { text, strategy, confirmation_message } = config;

  // Strategy: round_robin, random, or specific_agent_id
  let agentId = null;
  let agentName = 'our sales representative';

  if (strategy === 'specific_agent_id' && config.agent_id) {
    agentId = config.agent_id;
  } else {
    const agents = await db.getActiveAgents(lead.client_id);
    if (agents.length > 0) {
      if (strategy === 'random') {
        const idx = Math.floor(Math.random() * agents.length);
        agentId = agents[idx].agent_id;
        agentName = agents[idx].name;
      } else {
        // Default: round_robin (first available for now)
        agentId = agents[0].agent_id;
        agentName = agents[0].name;
      }
    }
  }

  if (agentId) {
    const agent = await db.getAgentById(agentId);
    if (agent) {
      agentName = agent.name;
    }
    await db.assignAgentToLead(lead.lead_id, agentId);
  }

  const message = confirmation_message
    ? confirmation_message.replace(/\{\{agent_name\}\}/g, agentName)
    : text || `You have been assigned to ${agentName}.`;

  await send({
    phoneNumberId: client.meta_phone_number_id,
    accessToken: client.meta_access_token,
    payload: textMessage(to, message),
  });

  return { success: true, type: 'AGENT_ASSIGNED', agent_id: agentId };
}

module.exports = { execute };