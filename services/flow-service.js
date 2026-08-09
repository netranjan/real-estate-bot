const db = require('../db/queries');

// ═══════════════════════════════════════
// CARD TEMPLATE REGISTRY (Pre‑built defaults)
// ═══════════════════════════════════════

const CARD_TEMPLATES = {
  question: {
    nodeType: 'collect_input',
    defaultConfig: {
      text: 'Please select an option:',
      options: [
        { label: 'Option 1', value: 'option1' },
        { label: 'Option 2', value: 'option2' }
      ],
      field: 'answer'
    },
    meta: { icon: '❓', color: 'purple', label: 'Question' }
  },
  message: {
    nodeType: 'send_message',
    defaultConfig: {
      text: 'Thank you for your interest!'
    },
    meta: { icon: '📝', color: 'blue', label: 'Message' }
  },
  property_list: {
    nodeType: 'show_list',
    defaultConfig: {
      text: 'Here are matching properties:',
      source_table: 'properties',
      filter_mode: 'all',
      match_dimensions: []
    },
    meta: { icon: '🏠', color: 'green', label: 'Property List' }
  },
  property_welcome: {
    nodeType: 'property_welcome',
    defaultConfig: {
      text: 'Welcome to our project!',
      buttons: [
        { id: 'GET_BROCHURE', title: 'Get Brochure' },
        { id: 'BOOK_VISIT', title: 'Book Site Visit' },
        { id: 'CALL_ME', title: 'Call Me' }
      ]
    },
    meta: { icon: '🏢', color: 'indigo', label: 'Welcome' }
  },
  brochure: {
    nodeType: 'send_document',
    defaultConfig: {
      text: 'Here is the brochure:',
      document_url_field: 'selected_property.brochure_url',
      filename: 'Brochure.pdf'
    },
    meta: { icon: '📄', color: 'orange', label: 'Brochure' }
  },
  book_visit: {
    nodeType: 'book_appointment',
    defaultConfig: {
      text: 'Choose a visit slot:'
    },
    meta: { icon: '📅', color: 'pink', label: 'Book Visit' }
  },
  callback: {
    nodeType: 'request_callback',
    defaultConfig: {
      text: 'We will call you back shortly.',
      sla_minutes: 15
    },
    meta: { icon: '📞', color: 'teal', label: 'Callback' }
  },
  end_conversation: {
    nodeType: 'end_conversation',
    defaultConfig: {
      text: 'Thank you for your time! Have a great day. 👋'
    },
    meta: { icon: '🛑', color: 'red', label: 'End' }
  }
};

function getCardTemplate(key) {
  return CARD_TEMPLATES[key] || null;
}

function getDefaultConfig(stepType) {
  const template = CARD_TEMPLATES[stepType];
  return template ? { ...template.defaultConfig } : {};
}

// ═══════════════════════════════════════
// FLOW CLONING
// ═══════════════════════════════════════

async function cloneFlow(flowId, targetClientId) {
  const sourceFlow = await db.getFlowById(flowId);
  if (!sourceFlow) throw new Error('Source flow not found');

  const newFlow = await db.createFlow({
    clientId: targetClientId || sourceFlow.client_id,
    flowName: `${sourceFlow.flow_name} (copy)`,
    flowVersion: sourceFlow.flow_version || 1,
    isActive: false,
    startNodeId: null
  });

  const sourceNodes = await db.getFlowNodes(flowId);
  const nodeIdMap = {};

  for (const node of sourceNodes) {
    const newNode = await db.createNode({
      flowId: newFlow.flow_id,
      nodeCode: node.node_code + '_clone',
      nodeType: node.node_type,
      nodeName: node.node_name,
      config: node.config || {},
      orderIndex: node.order_index
    });
    nodeIdMap[node.node_id] = newNode.node_id;
  }

  if (sourceFlow.start_node_id && nodeIdMap[sourceFlow.start_node_id]) {
    await db.updateFlow(newFlow.flow_id, { startNodeId: nodeIdMap[sourceFlow.start_node_id] });
  }

  const sourceEdges = await db.getFlowEdges(flowId);
  for (const edge of sourceEdges) {
    const fromId = nodeIdMap[edge.from_node_id];
    const toId = nodeIdMap[edge.to_node_id];
    if (fromId && toId) {
      await db.createEdge({
        flowId: newFlow.flow_id,
        fromNodeId: fromId,
        toNodeId: toId,
        userInputValue: edge.user_input_value,
        conditionLogic: edge.condition_logic || {},
        priority: edge.priority
      });
    }
  }

  return newFlow;
}

// ═══════════════════════════════════════
// (All existing functions unchanged)
// ═══════════════════════════════════════

async function getFullFlow(flowId) {
  const [flow, nodes, edges] = await Promise.all([
    db.getFlowById(flowId),
    db.getFlowNodes(flowId),
    db.getFlowEdges(flowId)
  ]);
  if (!flow) return null;

  const nodeMap = {};
  nodes.forEach(n => {
    n.connections = [];
    nodeMap[n.node_id] = n;
  });
  edges.forEach(e => {
    if (nodeMap[e.from_node_id]) {
      nodeMap[e.from_node_id].connections.push({
        edgeId: e.edge_id,
        userInput: e.user_input_value,
        outcomeName: e.outcome_name,
        toNodeId: e.to_node_id,
        toNodeName: e.to_name,
        conditionLogic: e.condition_logic
      });
    }
  });
  return { flow, nodes, edges };
}

async function reorderNodes(flowId, orderedNodeIds) {
  const updates = orderedNodeIds.map((nodeId, index) =>
    db.updateNodeOrder(nodeId, index)
  );
  await Promise.all(updates);
  return getFullFlow(flowId);
}

async function simulateStep({ flowId, currentNodeId, userInput, context = {}, answers = {} }) {
  const node = await db.getNodeById(currentNodeId);
  if (!node) return { done: true, message: 'Flow ended (no current node)' };

  const result = {
    done: false,
    nodeId: node.node_id,
    nodeName: node.node_name,
    nodeType: node.node_type,
    message: node.config.text || '(No message)',
    options: [],
    context: { ...context },
    answers: { ...answers },
    actions: []
  };

  const opts = node.config.options || node.config.buttons || [];
  result.options = opts.map(o => ({
    label: o.label || o.title || o,
    value: o.value || o.id || o.label || o.title || o
  }));

  if (!userInput) return result;

  const edges = await db.getEdgesFromNode(currentNodeId);
  let matchedEdge = edges.find(e => e.user_input_value === userInput);
  if (!matchedEdge) matchedEdge = edges.find(e => !e.user_input_value);

  if (!matchedEdge) {
    result.error = `No connection found for input: "${userInput}"`;
    return result;
  }

  const action = matchedEdge.condition_logic || {};
  if (action.action === 'save_answer' && action.field) {
    result.answers[action.field] = userInput;
    result.actions.push({ type: 'save_answer', field: action.field, value: userInput });
  }
  if (action.action === 'select_property') {
    const oldPropertyId = result.context.selected_property_id || null;
    const newPropertyId = parseInt(userInput, 10) || action.propertyId;
    if (newPropertyId) {
      result.context.selected_property_id = newPropertyId;
      result.actions.push({ type: 'select_property', oldPropertyId, newPropertyId });
    }
  }
  if (action.action === 'book_visit') {
    result.actions.push({ type: 'book_visit', propertyId: action.propertyId });
  }
  if (action.action === 'request_callback') {
    result.actions.push({ type: 'request_callback' });
  }
  if (action.action === 'score_lead') {
    result.actions.push({ type: 'score_lead', score: action.score });
  }

  const nextNode = await db.getNodeById(matchedEdge.to_node_id);
  if (nextNode) {
    result.nextNodeId = nextNode.node_id;
    result.nextNodeName = nextNode.node_name;
  } else {
    result.done = true;
  }
  return result;
}

async function simulateFullFlow(flowId, startNodeId, scenarioInputs = []) {
  const flow = await getFullFlow(flowId);
  if (!flow) throw new Error('Flow not found');

  const log = [];
  let currentNodeId = startNodeId;
  if (!currentNodeId && flow.nodes && flow.nodes.length > 0) {
    currentNodeId = flow.nodes[0].node_id;
  }
  let context = {};
  let answers = {};

  const firstStep = await simulateStep({ flowId, currentNodeId, context, answers });
  log.push({ ...firstStep, step: 0, userInput: null });

  for (let i = 0; i < scenarioInputs.length; i++) {
    const input = scenarioInputs[i];
    const step = await simulateStep({ flowId, currentNodeId, userInput: input, context, answers });
    log.push({ ...step, step: i + 1, userInput: input });
    if (step.done || !step.nextNodeId) break;
    currentNodeId = step.nextNodeId;
    context = step.context;
    answers = step.answers;

    const nextStep = await simulateStep({ flowId, currentNodeId, context, answers });
    if (!nextStep.done) {
      log.push({ ...nextStep, step: i + 1, userInput: null });
    }
  }
  return { flow, log };
}

async function selectPropertyForLead(leadId, propertyId, nodeId) {
  const lead = await db.getLeadById(leadId);
  if (!lead) throw new Error('Lead not found');

  let context = lead.context_data || {};
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch (e) { context = {}; }
  }
  const oldPropertyId = context.selected_property_id || null;

  if (oldPropertyId && oldPropertyId !== propertyId) {
    await db.logPropertySelection(leadId, oldPropertyId, propertyId, nodeId);
  }

  context.selected_property_id = propertyId;
  await db.updateLeadContext(leadId, context);
  await db.saveLeadAnswer(leadId, 'selected_property_id', String(propertyId), nodeId);
  return { leadId, oldPropertyId, newPropertyId: propertyId, context };
}

function buildEdgeAction(type, config = {}) {
  switch (type) {
    case 'save_answer': return { action: 'save_answer', field: config.field };
    case 'select_property': return { action: 'select_property' };
    case 'book_visit': return { action: 'book_visit' };
    case 'request_callback': return { action: 'request_callback' };
    case 'score_lead': return { action: 'score_lead', score: config.score };
    case 'assign_agent': return { action: 'assign_agent', agentId: config.agentId };
    default: return {};
  }
}

module.exports = {
  getFullFlow,
  reorderNodes,
  simulateStep,
  simulateFullFlow,
  selectPropertyForLead,
  buildEdgeAction,
  getCardTemplate,
  getDefaultConfig,
  cloneFlow
  // validateFlow removed
};