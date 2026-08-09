// core/handlers.js
// All node handlers. WhatsApp credentials resolved automatically.
// [PASS1] Hardcoded side effects removed. Outcomes returned for engine routing.

const WhatsAppClient = require('../transport/whatsapp');
const repo = require('../db/repository');
const { formatPrice } = require('../utils/format-price');
const { resolveString } = require('./context');
const scoringService = require('../services/scoring-service');
const callbackService = require('../services/callback-service');
const propertyService = require('../services/property-service');

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getWhatsApp(lead) {
  return WhatsAppClient.forLead(lead);
}

function fmtPropertyItem(p) {
  const year = p.possession_date
    ? new Date(p.possession_date).getFullYear()
    : 'Ready';
  const priceMin = p.price_min ? formatPrice(p.price_min) : '';
  const priceMax = p.price_max ? formatPrice(p.price_max) : '';
  const priceStr = priceMin && priceMax && priceMin !== priceMax
    ? `${priceMin} - ${priceMax}`
    : (priceMin || priceMax || '');
  return {
    id: `PROPERTY_${p.property_id}`,
    title: String(p.property_name).slice(0, 24),
    description: `${priceStr} | ${year}`.slice(0, 72),
  };
}

async function sendPropertyAssets(lead, propertyId, assetType, waInstance) {
  const typeFilter = assetType || 'all';
  const property = await repo.getPropertyById(propertyId);
  const dbAssets = await repo.getPropertyAssets(propertyId);

  const items = [];
  const seen = new Set();

  if (property?.brochure_url && (typeFilter === 'brochure' || typeFilter === 'all')) {
    items.push({ type: 'document', url: property.brochure_url, name: 'Brochure.pdf' });
    seen.add(property.brochure_url);
  }

  for (const asset of dbAssets) {
    if (!asset.asset_url) continue;
    if (typeFilter !== 'all' && asset.asset_type !== typeFilter) continue;
    if (seen.has(asset.asset_url)) continue;
    seen.add(asset.asset_url);
    items.push({
      type: asset.asset_type || 'document',
      url: asset.asset_url,
      name: asset.asset_name || 'File',
    });
  }

  if (items.length === 0) return 0;

  const to = lead.whatsapp_number;
  for (const item of items) {
    if (item.type === 'image') await waInstance.sendImage(to, item.url, item.name);
    else if (item.type === 'video') await waInstance.sendVideo(to, item.url, item.name);
    else await waInstance.sendDocument(to, item.url, item.name);
  }
  return items.length;
}

async function sendStaticAssets(lead, mediaItems, waInstance) {
  if (!mediaItems || !mediaItems.length) return 0;
  const to = lead.whatsapp_number;
  let count = 0;
  for (const item of mediaItems) {
    const url = item.url || item.document_url || '';
    const type = item.type || 'document';
    const name = item.name || item.filename || 'file';
    if (!url) continue;
    count++;
    if (type === 'image') await waInstance.sendImage(to, url, name);
    else if (type === 'video') await waInstance.sendVideo(to, url, name);
    else await waInstance.sendDocument(to, url, name);
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. send_message
// ═══════════════════════════════════════════════════════════════════════════════

async function sendMessage(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const source = config.source || 'auto';
  const propertyId = lead.context_data?.selected_property_id;

  if (source === 'static' && config.media_items?.length) {
    const count = await sendStaticAssets(lead, config.media_items, wa);
    if (count) return { success: true, type: 'STATIC_ASSETS_SENT', count };
  }

  if (propertyId && (source === 'property' || source === 'auto')) {
    const count = await sendPropertyAssets(lead, propertyId, config.property_asset_type, wa);
    if (count) return { success: true, type: 'PROPERTY_ASSETS_SENT', count };
  }

  if (source === 'auto' && config.media_items?.length) {
    const count = await sendStaticAssets(lead, config.media_items, wa);
    if (count) return { success: true, type: 'STATIC_ASSETS_SENT', count };
  }

  const text = config.text || '';
  if (text) await wa.sendText(to, text);
  return { success: true, type: 'TEXT_SENT', outcome: 'sent' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. collect_input
// ═══════════════════════════════════════════════════════════════════════════════

async function collectInput(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const { text, options, header } = config;

  if (!text) throw new Error('collect_input node missing "text" in config');

  if (options && options.length > 0) {
    if (options.length <= 3) {
      const buttons = options.map((opt) => ({
        id: String(opt.value || opt),
        title: String(opt.label || opt).slice(0, 20),
      }));
      await wa.sendButtons(to, text, buttons, header);
    } else {
      const sections = [{
        title: config.list_title || 'Options',
        rows: options.map((opt) => ({
          id: String(opt.value || opt),
          title: String(opt.label || opt).slice(0, 24),
        })),
      }];
      await wa.sendList(to, text, config.button_text || 'Select', sections, header, config.footer);
    }
  } else {
    await wa.sendText(to, text);
  }

  return { success: true, type: 'QUESTION_SENT', field: config.field };
}

// [PASS1] Returns outcome for engine routing
async function saveCollectReply(lead, config, userInput) {
  const { field, options } = config;
  if (!field) throw new Error('collect_input node missing "field" in config');

  const rawInput = String(userInput || '').trim();
  // Some clients send the question text + answer; grab the last line as the real answer
  const lastLine = rawInput.split(/\r?\n/).filter(l => l.trim()).pop() || '';
  const candidates = [rawInput, lastLine];

  if (!options || !options.length) {
    await repo.saveLeadAnswer(lead.lead_id, field, rawInput, lead.current_node_id);
    return { valid: true, outcome: 'free_text', field, value: rawInput };
  }

  for (const input of candidates) {
    const byValue = options.find(opt => {
      const val = String(opt.value || opt).trim();
      return val.toLowerCase() === input.toLowerCase();
    });
    if (byValue) {
      const val = String(byValue.value || byValue).trim();
      await repo.saveLeadAnswer(lead.lead_id, field, val, lead.current_node_id);
      return { valid: true, outcome: 'option_picked', field, value: val };
    }

    const byLabel = options.find(opt => {
      const label = String(opt.label || opt.value || opt).trim();
      return label.toLowerCase() === input.toLowerCase();
    });
    if (byLabel) {
      const val = String(byLabel.value || byLabel.label || byLabel).trim();
      await repo.saveLeadAnswer(lead.lead_id, field, val, lead.current_node_id);
      return { valid: true, outcome: 'option_picked', field, value: val };
    }
  }

  // Free text that didn't match any option
  await repo.saveLeadAnswer(lead.lead_id, field, rawInput, lead.current_node_id);
  return { valid: true, outcome: 'free_text', field, value: rawInput };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. show_list  [PASS1] — returns outcomes, no hardcoded empty message
// ═══════════════════════════════════════════════════════════════════════════════

async function showList(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const { text, list_title, button_text, header, footer } = config;
  const mode = config.filter_mode || 'all';

  let items = [];
  const answers = (await repo.getLeadAnswers(lead.lead_id)).reduce((m, a) => {
    m[a.field_name] = a.field_value; return m;
  }, {});

  if (mode === 'filtered' || mode === 'smart') {
    const dims = config.match_dimensions || [];
    const hasOldConditions = config.filter_conditions && config.filter_conditions.length > 0;

    if (dims.length > 0) {
      const filtered = await propertyService.getSmartFilteredProperties(lead.client_id, answers, dims);
      items = filtered.map(fmtPropertyItem);
    } else if (hasOldConditions) {
      const filtered = await propertyService.getFilteredProperties(lead.client_id, config.filter_conditions, answers);
      items = filtered.map(fmtPropertyItem);
    } else {
      items = (await repo.getPropertiesByClient(lead.client_id)).map(fmtPropertyItem);
    }
  } else {
    items = (await repo.getPropertiesByClient(lead.client_id)).map(fmtPropertyItem);
  }

  // [PASS1] Empty state is now handled by outcome routing in the engine.
  // Business owner draws: show_list.no_match → [their message node]
  if (items.length === 0) {
    return { success: true, type: 'LIST_EMPTY', outcome: 'no_match' };
  }

  const sections = [{
    title: list_title || 'Select',
    rows: items.map(it => ({
      id: String(it.id),
      title: String(it.title).slice(0, 24),
      description: it.description,
    })),
  }];

  await wa.sendList(to, text || 'Here are matching properties:', button_text || 'View Options', sections, header, footer);
  return { success: true, type: 'LIST_SENT', item_count: items.length, wait_for_input: true };
}

async function saveShowListReply(_lead, _config, userInput) {
  if (!String(userInput).startsWith('PROPERTY_')) {
    return { valid: false, error: 'Invalid selection' };
  }
  const propertyId = parseInt(userInput.replace('PROPERTY_', ''), 10);
  if (isNaN(propertyId)) return { valid: false, error: 'Invalid property ID' };
  return { valid: true, outcome: 'selected', value: userInput };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. property_welcome
// ═══════════════════════════════════════════════════════════════════════════════

async function propertyWelcome(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  if (!propertyId) {
    await wa.sendText(to, config.fallback_text || 'Please select a property first.');
    return { success: false, type: 'NO_PROPERTY_SELECTED' };
  }

  const property = await repo.getPropertyById(propertyId);
  if (!property) {
    await wa.sendText(to, 'Sorry, that property is no longer available.');
    return { success: false, type: 'PROPERTY_NOT_FOUND' };
  }

  let messageText = property.welcome_message || '';
  if (config.suffix_text) messageText += '\n\n' + config.suffix_text;

  messageText = await resolveString(messageText, lead.lead_id);

  const buttons = (config.buttons || []).map(b => ({
    id: String(b.id),
    title: String(b.title).slice(0, 20),
  }));

  if (buttons.length > 0 && buttons.length <= 3) {
    await wa.sendButtons(to, messageText, buttons, config.header);
  } else {
    await wa.sendText(to, messageText);
  }

  return { success: true, type: 'PROPERTY_WELCOME_SENT', outcome: 'button_clicked', property_id: propertyId, property_name: property.property_name };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. send_document
// ═══════════════════════════════════════════════════════════════════════════════

async function sendDocument(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  if (propertyId) {
    const count = await sendPropertyAssets(lead, propertyId, config.property_asset_type, wa);
    if (count) return { success: true, type: 'PROPERTY_ASSETS_SENT', count, outcome: 'sent' };
  }

  if (config.media_items && config.media_items.length > 0) {
    const count = await sendStaticAssets(lead, config.media_items, wa);
    if (count) return { success: true, type: 'STATIC_ASSETS_SENT', count, outcome: 'sent' };
  }

  let url = config.document_url || null;
  if (!url && config.document_url_field === 'selected_property.brochure_url' && propertyId) {
    const property = await repo.getPropertyById(propertyId);
    if (property) url = property.brochure_url || null;
  }

  if (!url) {
    const fallback = config.fallback_text || 'Sorry, the document is not available right now.';
    await wa.sendText(to, fallback);
    return { success: false, type: 'NO_DOCUMENT_AVAILABLE', outcome: 'not_found' };
  }

  await wa.sendDocument(to, url, config.filename || 'Document.pdf');
  return { success: true, type: 'LEGACY_DOCUMENT_SENT', outcome: 'sent', url };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. book_appointment  [PASS1] — returns outcomes
// ═══════════════════════════════════════════════════════════════════════════════

async function bookAppointment(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const propertyId = lead.context_data?.selected_property_id;

  let rows = [];
  if (propertyId) {
    const slots = await repo.getVisitOptionsForProperty(propertyId);
    if (slots.length > 0) {
      rows = slots.map(s => ({
        id: `VISIT_${s.visit_option_id}`,
        title: String(s.option_name || 'Visit').slice(0, 24),
        description: '',
      }));
    }
  }

  if (rows.length === 0 && config.options && config.options.length > 0) {
    rows = config.options.map((opt, idx) => ({
      id: `VISIT_${idx}`,
      title: String(opt.label || opt.value || 'Slot').slice(0, 24),
      description: String(opt.description || '').slice(0, 72),
    }));
  }

  if (rows.length > 0) {
    await wa.sendList(to, config.text || "Let's schedule your site visit! 🏗️\n\nPlease pick a convenient slot.", 'Select Slot', [
      { title: 'Available Slots', rows }
    ]);
    return { success: true, type: 'SLOT_LIST_SENT', wait_for_input: true };
  }

  // [PASS1] No slots = outcome, not hardcoded dead end
  return { success: true, type: 'NO_SLOTS_AVAILABLE', outcome: 'no_slots' };
}

// [PASS1] Returns outcome for engine routing
async function saveVisitReply(lead, _config, userInput) {
  if (!String(userInput).startsWith('VISIT_')) {
    return { valid: false, error: 'Invalid visit option' };
  }
  const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
  if (isNaN(visitOptionId)) return { valid: false, error: 'Invalid visit option ID' };

  const propertyId = lead.context_data?.selected_property_id;
  if (!propertyId) return { valid: false, error: 'No property selected' };

  await repo.createSiteVisit({
    leadId: lead.lead_id,
    propertyId,
    visitOptionId,
    agentId: lead.assigned_agent_id || null,
  });
  await repo.updateLeadPipeline(lead.lead_id, 'Site Visit Booked');
  return { valid: true, outcome: 'slot_picked', visit_id: visitOptionId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. request_callback
// ═══════════════════════════════════════════════════════════════════════════════

async function requestCallback(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const { sla_minutes, assign_to } = config;

  const confirmation_message = config.confirmation_message || config.text;

  let agentId = lead.assigned_agent_id || null;
  let agentName = 'our sales representative';

  if (!agentId && assign_to === 'available_agent') {
    const agents = await repo.getActiveAgents(lead.client_id);
    if (agents.length > 0) {
      agentId = agents[0].agent_id;
      agentName = agents[0].name;
    }
  } else if (agentId) {
    const agent = await repo.getAgentById(agentId);
    if (agent) agentName = agent.name;
  }

  const callback = await callbackService.requestCallback({
    leadId: lead.lead_id,
    assignedAgentId: agentId,
    slaMinutes: sla_minutes || 15,
  });

  if (agentId && !lead.assigned_agent_id) {
    await repo.assignAgentToLead(lead.lead_id, agentId);
  }
  await repo.updateLeadPipeline(lead.lead_id, 'Callback Requested');

  const message = confirmation_message
    ? confirmation_message.replace(/\{\{agent_name\}\}/g, agentName)
    : `Got it! ${agentName} will call you on this WhatsApp number within ${sla_minutes || 15} minutes. 📞\n\nThank you for reaching out!`;

  await wa.sendText(to, message);
  return { success: true, type: 'CALLBACK_REQUESTED', outcome: 'requested', callback_id: callback.callback_request_id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. assign_agent
// ═══════════════════════════════════════════════════════════════════════════════

async function assignAgent(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const { text, strategy, confirmation_message } = config;

  let agentId = null;
  let agentName = 'our sales representative';

  if (strategy === 'specific_agent_id' && config.agent_id) {
    agentId = config.agent_id;
  } else {
    const agents = await repo.getActiveAgents(lead.client_id);
    if (agents.length > 0) {
      if (strategy === 'random') {
        const idx = Math.floor(Math.random() * agents.length);
        agentId = agents[idx].agent_id;
        agentName = agents[idx].name;
      } else {
        agentId = agents[0].agent_id;
        agentName = agents[0].name;
      }
    }
  }

  if (agentId) {
    const agent = await repo.getAgentById(agentId);
    if (agent) agentName = agent.name;
    await repo.assignAgentToLead(lead.lead_id, agentId);
  }

  const message = confirmation_message
    ? confirmation_message.replace(/\{\{agent_name\}\}/g, agentName)
    : (text || `You have been assigned to ${agentName}.`);

  await wa.sendText(to, message);
  return { success: true, type: 'AGENT_ASSIGNED', outcome: 'assigned', agent_id: agentId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. calculate_score
// ═══════════════════════════════════════════════════════════════════════════════

async function calculateScore(lead, config) {
  const wa = await getWhatsApp(lead);
  const score = await scoringService.calculateLeadScore(lead.lead_id);

  if (config.notify_lead) {
    const to = lead.whatsapp_number;
    const message = config.notify_message
      ? config.notify_message.replace(/\{\{score\}\}/g, score)
      : `Your profile score: ${score}/100. Our team will reach out shortly.`;
    await wa.sendText(to, message);
  }

  return { success: true, type: 'SCORE_CALCULATED', outcome: 'scored', score };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. end_conversation
// ═══════════════════════════════════════════════════════════════════════════════

async function endConversation(lead, config) {
  const wa = await getWhatsApp(lead);
  const to = lead.whatsapp_number;
  const text = config.text || 'Thank you for reaching out. We will get back to you soon.';

  await wa.sendText(to, text);

  const ctx = lead.context_data || {};
  delete ctx.selected_property_id;
  delete ctx.selected_property_name;
  delete ctx.selected_visit_option_id;
  await repo.updateLeadContext(lead.lead_id, ctx);

  return { success: true, type: 'CONVERSATION_ENDED', outcome: 'ended' };
}

module.exports = {
  sendMessage,
  collectInput,
  saveCollectReply,
  showList,
  saveShowListReply,
  propertyWelcome,
  sendDocument,
  bookAppointment,
  saveVisitReply,
  requestCallback,
  assignAgent,
  calculateScore,
  endConversation,
};