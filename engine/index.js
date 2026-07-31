const leadService = require('../services/lead-service');
const db = require('../db/queries');
const stateMachine = require('./state-machine');

function extractMessageData(body) {
  if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return null;

  const value = body.entry[0].changes[0].value;
  const msg = value.messages[0];
  const contact = value.contacts?.[0] || {};

  // Determine user input: button reply, list reply, or plain text
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
    // Determine client from phone_number_id (Meta sends this per webhook)
    let clientId = parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
    let client = null;

    if (phone_number_id) {
      client = await db.getClientByPhoneNumberId(phone_number_id);
      if (client) {
        clientId = client.client_id;
      }
    }

    // Find or create lead
    let lead = await leadService.findOrCreateLead({
      whatsappNumber: wa_id,
      name: profile_name || null,
      clientId,
    });

    // Handle referral (ad click with ref code) — auto-select property
    if (referral_ref && !lead.context_data?.selected_property_id) {
      const property = await db.getPropertyByReferralCode(referral_ref);
      if (property && property.client_id === clientId) {
        await leadService.saveToContext(lead.lead_id, 'selected_property_id', property.property_id);
        await leadService.saveToContext(lead.lead_id, 'selected_property_name', property.property_name);
        console.log('🔗 Referral property selected:', property.property_name);
      }
    }

    // Reload lead with fresh state
    lead = await db.getLeadById(lead.lead_id);

    // If lead has no current node (shouldn't happen, but safety net)
    if (!lead.current_node_id) {
      const flow = await db.getActiveFlowForClient(clientId);
      if (flow && flow.start_node_id) {
        await db.updateLeadNode(lead.lead_id, flow.start_node_id);
        lead = await db.getLeadById(lead.lead_id);
      }
    }

    // If this is a brand new lead (just created), auto-start the flow
    const historyCount = (await db.getLeadAnswers(lead.lead_id)).length;
    const isFreshLead = historyCount === 0 && !user_input;

    if (isFreshLead) {
      const startNode = await db.getNodeById(lead.current_node_id);
      if (startNode) {
        console.log('🚀 Auto-starting flow for new lead');
        await stateMachine.executeAndChain(lead, startNode);
        return;
      }
    }

    // Process the user's message through the state machine
    await stateMachine.processMessage(lead, user_input);

  } catch (error) {
    console.error('❌ Engine error:', error.message);
    // Optionally send error fallback to user
  }
}

module.exports = { handleIncomingMessage };