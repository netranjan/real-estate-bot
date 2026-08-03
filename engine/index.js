const leadService = require('../services/lead-service');
const db = require('../db/queries');
const stateMachine = require('./state-machine');

function extractMessageData(body) {
  if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return null;

  const value = body.entry[0].changes[0].value;
  const msg = value.messages[0];
  const contact = value.contacts?.[0] || {};

  let userInput = '';
  if (msg.interactive?.button_reply?.id) {
    userInput = msg.interactive.button_reply.id;
  } else if (msg.interactive?.list_reply?.id) {
    userInput = msg.interactive.list_reply.id;
  } else if (msg.text?.body) {
    userInput = msg.text.body.trim();
  }

  return {
    wa_id: contact.wa_id || msg.from,
    profile_name: contact.profile?.name || '',
    message_text: msg.text?.body || '',
    user_input: userInput,
    referral_ref: msg.referral?.ref || '',
    phone_number_id: value.metadata?.phone_number_id || null,
  };
}

async function handleIncomingMessage(body) {
  const data = extractMessageData(body);
  if (!data) {
    console.log('⚠️ No message data in webhook');
    return;
  }

  const { wa_id, profile_name, user_input, referral_ref, phone_number_id } = data;
  console.log('📩 Incoming:', wa_id, '| Input:', user_input || '(text)');

  try {
    let clientId = parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
    let client = null;

    if (phone_number_id) {
      client = await db.getClientByPhoneNumberId(phone_number_id);
      if (client) clientId = client.client_id;
    }

    let lead = await leadService.findOrCreateLead({
      whatsappNumber: wa_id,
      name: profile_name || null,
      clientId,
    });

    // Attach referral property if present
    if (referral_ref && !lead.context_data?.selected_property_id) {
      const property = await db.getPropertyByReferralCode(referral_ref);
      if (property && property.client_id === clientId) {
        await leadService.saveToContext(lead.lead_id, 'selected_property_id', property.property_id);
        await leadService.saveToContext(lead.lead_id, 'selected_property_name', property.property_name);
      }
    }

    lead = await db.getLeadById(lead.lead_id);

    const flow = await db.getActiveFlowForClient(clientId);
    if (!flow) {
      console.error('❌ No active flow for client', clientId);
      return;
    }

    // RESET lead if it's on a different flow or invalid node
    const needsReset = !lead.current_flow_id || lead.current_flow_id !== flow.flow_id;
    if (!needsReset && lead.current_node_id) {
      const nodeCheck = await db.getNodeById(lead.current_node_id);
      if (!nodeCheck || nodeCheck.flow_id !== flow.flow_id) {
        console.log(`🔄 Lead ${lead.lead_id} node ${lead.current_node_id} not in active flow ${flow.flow_id}, resetting`);
        await db.updateLeadNode(lead.lead_id, flow.start_node_id);
        lead = await db.getLeadById(lead.lead_id);
      }
    }
    if (needsReset) {
      console.log(`🔄 Lead ${lead.lead_id} flow mismatch (${lead.current_flow_id} vs ${flow.flow_id}), resetting to start`);
      await db.updateLeadNode(lead.lead_id, flow.start_node_id);
      await db.pool.query(
        'UPDATE leads SET current_flow_id = $1 WHERE lead_id = $2',
        [flow.flow_id, lead.lead_id]
      );
      // Clear old answers so the new flow starts fresh
      await db.pool.query('DELETE FROM lead_answers WHERE lead_id = $1', [lead.lead_id]);
      lead = await db.getLeadById(lead.lead_id);
    }

    // Only auto‑start on the very first message (no answers yet, at start node, not already started)
    const answersCount = (await db.getLeadAnswers(lead.lead_id)).length;
    const flowStarted = lead.context_data?.flow_started;

    if (answersCount === 0 && lead.current_node_id === flow.start_node_id && !flowStarted) {
      const startNode = await db.getNodeById(lead.current_node_id);
      if (startNode) {
        console.log('🚀 First message – auto-starting flow');
        await stateMachine.executeAndChain(lead, startNode);
        await leadService.saveToContext(lead.lead_id, 'flow_started', true);
        return;
      }
    }

    // Normal input processing (after flow has started)
    if (user_input) {
      await stateMachine.processMessage(lead, user_input);
    }

  } catch (error) {
    console.error('❌ Engine error:', error.message);
    console.error(error.stack);
  }
}

module.exports = { handleIncomingMessage };