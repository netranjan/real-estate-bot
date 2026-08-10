// core/simple-engine.js
// One function per node. No registry. No outcomes in execute. No stale recovery.
// Every transition is: handler → getEdge → next node. That's it.

const repo = require('../db/repository');
const WhatsAppClient = require('../transport/whatsapp');
const propertyService = require('../services/property-service');
const { resolveString } = require('./context');
const { formatPrice } = require('../utils/format-price');
const leadService = require('../services/lead-service');

// ── HELPERS ──
function parseCtx(lead) {
  let ctx = lead.context_data || {};
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch (e) { ctx = {}; }
  }
  return ctx;
}

async function getEdge(fromNodeId, userInput, outcome) {
  const edges = await repo.getEdgesFromNode(fromNodeId);
  if (!edges.length) return null;

  if (userInput) {
    const e = edges.find(x => String(x.user_input_value).trim().toLowerCase() === String(userInput).trim().toLowerCase());
    if (e) return e;
  }

  if (outcome) {
    const e = edges.find(x => x.outcome_name === outcome);
    if (e) return e;
  }

  return edges.find(x => !x.user_input_value && !x.outcome_name) || null;
}

async function sendMessages(lead, messages) {
  if (!messages?.length) return;
  const wa = await WhatsAppClient.forLead(lead);
  for (const m of messages) {
    try {
      if (m.type === 'text') await wa.sendText(lead.whatsapp_number, m.text);
      else if (m.type === 'buttons') await wa.sendButtons(lead.whatsapp_number, m.text, m.buttons, m.header);
      else if (m.type === 'list') await wa.sendList(lead.whatsapp_number, m.text, m.buttonText, m.sections, m.header, m.footer);
      else if (m.type === 'document') await wa.sendDocument(lead.whatsapp_number, m.url, m.filename);
      else if (m.type === 'image') await wa.sendImage(lead.whatsapp_number, m.url, m.caption);
      else if (m.type === 'video') await wa.sendVideo(lead.whatsapp_number, m.url, m.caption);
    } catch (err) {
      console.error('❌ Send failed:', err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NODE HANDLERS — one function per type. Returns { messages, nextEdge, wait }.
// ═══════════════════════════════════════════════════════════════

const handlers = {
  collect_input: async (lead, cfg, input) => {
    if (!input) {
      const opts = (cfg.options || []).map(o => ({
        id: String(o.value || o),
        title: String(o.label || o).slice(0, 20)
      }));
      return {
        messages: [{ type: 'buttons', text: cfg.text, buttons: opts.slice(0, 3), header: cfg.header }],
        wait: true
      };
    }
    const opt = (cfg.options || []).find(o =>
      String(o.value || o).toLowerCase() === input.toLowerCase() ||
      String(o.label || o).toLowerCase() === input.toLowerCase()
    );
    if (!opt) return { wait: true };
    const val = String(opt.value || opt.label || opt);
    await repo.saveLeadAnswer(lead.lead_id, cfg.field, val, lead.current_node_id);
    return { nextEdge: await getEdge(lead.current_node_id, val) };
  },

  show_list: async (lead, cfg, input) => {
    if (!input) {
      let items = [];
      const mode = cfg.filter_mode || 'all';
      const answers = (await repo.getLeadAnswers(lead.lead_id)).reduce((m, a) => {
        m[a.field_name] = a.field_value; return m;
      }, {});

      if (mode === 'filtered' || mode === 'smart') {
        const dims = cfg.match_dimensions || [];
        if (dims.length > 0) {
          items = (await propertyService.getSmartFilteredProperties(lead.client_id, answers, dims)).map(p => ({
            id: `PROPERTY_${p.property_id}`,
            title: String(p.property_name).slice(0, 24),
            description: `${p.price_min ? formatPrice(p.price_min) : ''} - ${p.price_max ? formatPrice(p.price_max) : ''} | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`.slice(0, 72),
          }));
        } else {
          items = (await repo.getPropertiesByClient(lead.client_id)).map(p => ({
            id: `PROPERTY_${p.property_id}`,
            title: String(p.property_name).slice(0, 24),
            description: `${p.price_min ? formatPrice(p.price_min) : ''} - ${p.price_max ? formatPrice(p.price_max) : ''} | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`.slice(0, 72),
          }));
        }
      } else {
        items = (await repo.getPropertiesByClient(lead.client_id)).map(p => ({
          id: `PROPERTY_${p.property_id}`,
          title: String(p.property_name).slice(0, 24),
          description: `${p.price_min ? formatPrice(p.price_min) : ''} - ${p.price_max ? formatPrice(p.price_max) : ''} | ${p.possession_date ? new Date(p.possession_date).getFullYear() : 'Ready'}`.slice(0, 72),
        }));
      }

      if (items.length === 0) {
        return { nextEdge: await getEdge(lead.current_node_id, null, 'no_match') };
      }

      return {
        messages: [{
          type: 'list',
          text: cfg.text || 'Here are matching properties:',
          buttonText: cfg.button_text || 'View Options',
          sections: [{ title: cfg.list_title || 'Select', rows: items }],
          header: cfg.header,
          footer: cfg.footer
        }],
        wait: true
      };
    }

    if (!String(input).startsWith('PROPERTY_')) return { wait: true };
    const pid = parseInt(input.replace('PROPERTY_', ''), 10);
    if (isNaN(pid)) return { wait: true };
    const property = await repo.getPropertyById(pid);
    if (!property) return { wait: true };

    await repo.saveLeadAnswer(lead.lead_id, 'selected_property_id', String(pid), lead.current_node_id);
    const ctx = parseCtx(lead);
    ctx.selected_property_id = pid;
    ctx.selected_property_name = property.property_name;
    await repo.updateLeadContext(lead.lead_id, ctx);

    return { nextEdge: await getEdge(lead.current_node_id, null, 'selected') };
  },

  property_welcome: async (lead, cfg, input) => {
    const pid = lead.context_data?.selected_property_id;
    if (!pid) {
      return {
        messages: [{ type: 'text', text: cfg.fallback_text || 'Please select a property first.' }],
        nextEdge: await getEdge(lead.current_node_id, null, 'no_property')
      };
    }

    if (!input) {
      const property = await repo.getPropertyById(pid);
      if (!property) {
        return {
          messages: [{ type: 'text', text: 'Sorry, that property is no longer available.' }],
          nextEdge: await getEdge(lead.current_node_id, null, 'not_found')
        };
      }
      let text = property.welcome_message || '';
      if (cfg.suffix_text) text += '\n\n' + cfg.suffix_text;
      text = await resolveString(text, lead.lead_id);
      const buttons = (cfg.buttons || []).map(b => ({ id: String(b.id), title: String(b.title).slice(0, 20) }));
      return {
        messages: [{ type: 'buttons', text, buttons, header: cfg.header }],
        wait: true
      };
    }

    return { nextEdge: await getEdge(lead.current_node_id, input) };
  },

  send_document: async (lead, cfg, input) => {
    const pid = lead.context_data?.selected_property_id;
    const messages = [];

    if (pid && (cfg.source === 'property' || cfg.source === 'auto' || !cfg.source)) {
      const property = await repo.getPropertyById(pid);
      if (property?.brochure_url) {
        messages.push({ type: 'document', url: property.brochure_url, filename: 'Brochure.pdf' });
      }
      const assets = await repo.getPropertyAssets(pid);
      for (const a of assets) {
        if (a.asset_type === 'image') messages.push({ type: 'image', url: a.asset_url, caption: a.asset_name });
        else if (a.asset_type === 'video') messages.push({ type: 'video', url: a.asset_url, caption: a.asset_name });
      }
    }

    if (messages.length === 0 && cfg.media_items?.length) {
      for (const item of cfg.media_items) {
        const url = item.url || item.document_url;
        if (!url) continue;
        const type = item.type || 'document';
        if (type === 'image') messages.push({ type: 'image', url, caption: item.caption || item.name });
        else if (type === 'video') messages.push({ type: 'video', url, caption: item.caption || item.name });
        else messages.push({ type: 'document', url, filename: item.filename || item.name || 'Document.pdf' });
      }
    }

    if (messages.length === 0) {
      return {
        messages: [{ type: 'text', text: cfg.fallback_text || 'Sorry, the document is not available right now.' }],
        nextEdge: await getEdge(lead.current_node_id, null, 'not_found')
      };
    }

    return { messages, nextEdge: await getEdge(lead.current_node_id, null, 'sent') };
  },

  book_appointment: async (lead, cfg, input) => {
    if (!input) {
      const pid = lead.context_data?.selected_property_id;
      let rows = [];
      if (pid) {
        const slots = await repo.getVisitOptionsForProperty(pid);
        rows = slots.map(s => ({ id: `VISIT_${s.visit_option_id}`, title: String(s.option_name || 'Visit').slice(0, 24) }));
      }
      if (rows.length === 0 && cfg.options?.length) {
        rows = cfg.options.map((opt, idx) => ({ id: `VISIT_${idx}`, title: String(opt.label || opt.value || 'Slot').slice(0, 24) }));
      }
      if (rows.length === 0) {
        return { nextEdge: await getEdge(lead.current_node_id, null, 'no_slots') };
      }
      return {
        messages: [{
          type: 'list',
          text: cfg.text || "Let's schedule your site visit! 🏗️\n\nPlease pick a convenient slot.",
          buttonText: 'Select Slot',
          sections: [{ title: 'Available Slots', rows }],
          header: cfg.header,
          footer: cfg.footer
        }],
        wait: true
      };
    }

    if (!String(input).startsWith('VISIT_')) return { wait: true };
    const vid = parseInt(input.replace('VISIT_', ''), 10);
    if (isNaN(vid)) return { wait: true };
    const pid = lead.context_data?.selected_property_id;
    if (!pid) return { wait: true };

    await repo.createSiteVisit({ leadId: lead.lead_id, propertyId: pid, visitOptionId: vid, agentId: lead.assigned_agent_id || null });
    await repo.updateLeadPipeline(lead.lead_id, 'Site Visit Booked');

    return { nextEdge: await getEdge(lead.current_node_id, null, 'slot_picked') };
  },

  request_callback: async (lead, cfg, input) => {
    let agentId = lead.assigned_agent_id || null;
    let agentName = 'our sales representative';

    if (!agentId && cfg.assign_to === 'available_agent') {
      const agents = await repo.getActiveAgents(lead.client_id);
      if (agents.length > 0) { agentId = agents[0].agent_id; agentName = agents[0].name; }
    } else if (agentId) {
      const agent = await repo.getAgentById(agentId);
      if (agent) agentName = agent.name;
    }

    await repo.createCallbackRequest({ leadId: lead.lead_id, assignedAgentId: agentId, slaMinutes: cfg.sla_minutes || 15 });
    if (agentId && !lead.assigned_agent_id) await repo.assignAgentToLead(lead.lead_id, agentId);
    await repo.updateLeadPipeline(lead.lead_id, 'Callback Requested');

    const text = (cfg.confirmation_message || cfg.text || `Got it! ${agentName} will call you on this WhatsApp number within ${cfg.sla_minutes || 15} minutes. 📞\n\nThank you for reaching out!`)
      .replace(/\{\{agent_name\}\}/g, agentName);

    return { messages: [{ type: 'text', text }], nextEdge: await getEdge(lead.current_node_id, null, 'requested') };
  },

  send_message: async (lead, cfg, input) => {
    const messages = [];
    const pid = lead.context_data?.selected_property_id;

    if (cfg.source === 'static' && cfg.media_items?.length) {
      for (const item of cfg.media_items) {
        const url = item.url || item.document_url;
        if (!url) continue;
        const type = item.type || 'document';
        if (type === 'image') messages.push({ type: 'image', url, caption: item.caption || item.name });
        else if (type === 'video') messages.push({ type: 'video', url, caption: item.caption || item.name });
        else messages.push({ type: 'document', url, filename: item.filename || item.name || 'Document.pdf' });
      }
    }

    if (pid && (cfg.source === 'property' || cfg.source === 'auto' || !cfg.source)) {
      const property = await repo.getPropertyById(pid);
      if (property?.brochure_url) messages.push({ type: 'document', url: property.brochure_url, filename: 'Brochure.pdf' });
      const assets = await repo.getPropertyAssets(pid);
      for (const a of assets) {
        if (a.asset_type === 'image') messages.push({ type: 'image', url: a.asset_url, caption: a.asset_name });
        else if (a.asset_type === 'video') messages.push({ type: 'video', url: a.asset_url, caption: a.asset_name });
      }
    }

    if (cfg.text) messages.push({ type: 'text', text: cfg.text });

    return { nextEdge: await getEdge(lead.current_node_id, null, 'sent') };
  },

  assign_agent: async (lead, cfg, input) => {
    let agentId = null;
    let agentName = 'our sales representative';

    if (cfg.strategy === 'specific_agent_id' && cfg.agent_id) {
      agentId = cfg.agent_id;
    } else {
      const agents = await repo.getActiveAgents(lead.client_id);
      if (agents.length > 0) {
        if (cfg.strategy === 'random') {
          const idx = Math.floor(Math.random() * agents.length);
          agentId = agents[idx].agent_id; agentName = agents[idx].name;
        } else {
          agentId = agents[0].agent_id; agentName = agents[0].name;
        }
      }
    }

    if (agentId) {
      const agent = await repo.getAgentById(agentId);
      if (agent) agentName = agent.name;
      await repo.assignAgentToLead(lead.lead_id, agentId);
    }

    const text = (cfg.confirmation_message || cfg.text || `You have been assigned to ${agentName}.`)
      .replace(/\{\{agent_name\}\}/g, agentName);

    return { messages: [{ type: 'text', text }], nextEdge: await getEdge(lead.current_node_id, null, 'assigned') };
  },

  calculate_score: async (lead, cfg, input) => {
    return { nextEdge: await getEdge(lead.current_node_id, null, 'scored') };
  },

  end_conversation: async (lead, cfg, input) => {
    const ctx = parseCtx(lead);
    delete ctx.selected_property_id;
    delete ctx.selected_property_name;
    delete ctx.selected_visit_option_id;
    await repo.updateLeadContext(lead.lead_id, ctx);
    return { messages: [{ type: 'text', text: cfg.text || 'Thank you for reaching out. We will get back to you soon.' }] };
  }
};

// Mark which handlers wait for user input
handlers.collect_input.waits = true;
handlers.show_list.waits = true;
handlers.property_welcome.waits = true;
handlers.book_appointment.waits = true;

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP — one node at a time, visible in logs
// ═══════════════════════════════════════════════════════════════

async function processNode(leadId, userInput) {
  let currentLead = await repo.getLeadById(leadId);
  let currentInput = userInput;

  while (true) {
    const node = await repo.getNodeById(currentLead.current_node_id);
    if (!node) { console.error('❌ No node:', currentLead.current_node_id); break; }

    const handler = handlers[node.node_type];
    if (!handler) { console.error('❌ Unknown type:', node.node_type); break; }

    console.log(`▶️ ${node.node_code} (${node.node_type}) input=${currentInput || '(none)'}`);

    const result = await handler(currentLead, node.config, currentInput);

    if (result.messages?.length) await sendMessages(currentLead, result.messages);

    if (result.nextEdge) {
      await repo.updateLeadNode(currentLead.lead_id, result.nextEdge.to_node_id);
      currentLead = await repo.getLeadById(currentLead.lead_id);
      const nextNode = await repo.getNodeById(result.nextEdge.to_node_id);
      if (!nextNode || handlers[nextNode.node_type]?.waits) break;
      currentInput = null; // auto-run next non-waiting node
    } else if (result.wait) {
      await repo.updateLeadNode(currentLead.lead_id, node.node_id);
      break;
    } else {
      console.warn(`⚠️ Dead end at ${node.node_code}`);
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK ENTRY
// ═══════════════════════════════════════════════════════════════

function extractMessageData(body) {
  if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return null;
  const value = body.entry[0].changes[0].value;
  const msg = value.messages[0];
  const contact = value.contacts?.[0] || {};

  let userInput = '';
  if (msg.interactive?.button_reply?.id) userInput = msg.interactive.button_reply.id;
  else if (msg.interactive?.list_reply?.id) userInput = msg.interactive.list_reply.id;
  else if (msg.text?.body) userInput = msg.text.body.trim();

  return {
    wa_id: contact.wa_id || msg.from,
    profile_name: contact.profile?.name || '',
    user_input: userInput,
    referral_ref: msg.referral?.ref || '',
    phone_number_id: value.metadata?.phone_number_id || null,
  };
}

async function handleIncomingMessage(body) {
  const data = extractMessageData(body);
  if (!data) return;

  const { wa_id, profile_name, user_input, referral_ref, phone_number_id } = data;
  console.log('📩 Incoming:', wa_id, '| Input:', user_input || '(text)');

  try {
    let clientId = parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
    if (phone_number_id) {
      const client = await repo.getClientByPhoneNumberId(phone_number_id);
      if (client) clientId = client.client_id;
    }

    let lead = await leadService.findOrCreateLead({ whatsappNumber: wa_id, name: profile_name || null, clientId });

    if (referral_ref && !lead.context_data?.selected_property_id) {
      const property = await repo.getPropertyByReferralCode(referral_ref);
      if (property && property.client_id === clientId) {
        await leadService.saveToContext(lead.lead_id, 'selected_property_id', property.property_id);
        await leadService.saveToContext(lead.lead_id, 'selected_property_name', property.property_name);
      }
    }

    lead = await repo.getLeadById(lead.lead_id);

    const flow = await repo.getActiveFlowForClient(clientId);
    if (!flow) { console.error('❌ No active flow'); return; }

    if (!lead.current_flow_id || lead.current_flow_id !== flow.flow_id) {
      console.log(`🔄 Resetting to flow ${flow.flow_id}`);
      await repo.updateLeadFlow(lead.lead_id, flow.flow_id, flow.start_node_id);
      await repo.deleteLeadAnswers(lead.lead_id);
      lead = await repo.getLeadById(lead.lead_id);
    }

    const answers = await repo.getLeadAnswers(lead.lead_id);
    const ctx = parseCtx(lead);

    if (answers.length === 0 && lead.current_node_id === flow.start_node_id && !ctx.flow_started) {
      const startNode = await repo.getNodeById(flow.start_node_id);
      if (startNode) {
        console.log('🚀 Auto-starting flow');
        await processNode(lead.lead_id, null);
        await leadService.saveToContext(lead.lead_id, 'flow_started', true);
        return;
      }
    }

    if (user_input) {
      await processNode(lead.lead_id, user_input);
    }

  } catch (error) {
    console.error('❌ Engine error:', error.message);
    console.error(error.stack);
  }
}

module.exports = { handleIncomingMessage };